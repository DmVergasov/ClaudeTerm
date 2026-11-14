// The `claude auth …` commands of the stand-in Claude Code (fake-claude.ts), for the accounts' sign-in. They keep the files
// Claude Code keeps under the config folder and answer as Claude Code does. Assumed from Claude Code 2.1.322's help output;
// nothing recorded. Node built-ins only, run with --experimental-strip-types.
// The `claude mcp …` and `claude plugin …` commands are in fake-claude.ts.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { FakeAuth, FakeScript } from './install'

type Json = Record<string, any>

export interface CliContext {
  script: FakeScript
  configDir: string
  cwd: string
  log: (entry: object) => void
}

/** the account a sign-in writes into a config folder: .claude.json's oauthAccount */
export interface Account {
  emailAddress: string
  organizationName: string
  organizationUuid: string
  organizationType: string
}

// the token of install.ts's FAKE_CREDENTIAL: this file runs without importing the tests' modules
const CREDENTIAL = 'fake-credential-never-shown-0001'

interface Parsed {
  words: string[] // the command's words, the group first; options and their values are left out
  email?: string
  text: boolean
}

function say(line: string): void {
  process.stdout.write(line + '\n')
}

function complain(line: string): number {
  process.stderr.write(line + '\n')
  return 1
}

function unknown(word: string | undefined): number {
  return complain(`error: unknown command '${word ?? ''}'`)
}

// the message a CLI call fails with, when the script names it (cliFail): its arguments, `--` left out, start with the key
function failure(argv: string[], script: FakeScript): string | undefined {
  const fails = script.cliFail ?? {}
  const line = argv.filter(arg => arg !== '--').join(' ')
  const key = Object.keys(fails).find(known => line.startsWith(known))
  return key === undefined ? undefined : fails[key]
}

// a JSON file, or {} when it is missing
function readJson(file: string): Json {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Json
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

// every write keeps the file's other keys, and makes the folders it needs
function writeJson(file: string, value: Json): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

// a UUID made from a folder's name, so the same folder always gets the same organization
function uuidOf(name: string): string {
  const hex = createHash('sha1').update(name).digest('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), '4' + hex.slice(13, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
}

// the account a sign-in writes for a folder's name; the FakeAuth of the script replaces its parts
export function accountOf(name: string, auth: FakeAuth = {}): Account {
  return {
    emailAddress: auth.email ?? `${name}@example.com`,
    organizationName: auth.org ?? 'Example Team',
    organizationUuid: auth.orgUuid ?? uuidOf(name),
    organizationType: auth.type ?? 'claude_team'
  }
}

// what `auth login` writes: the token in .credentials.json (mode 0600) and the account in .claude.json, its other keys kept
export function signIn(configDir: string, account: Account): void {
  mkdirSync(configDir, { recursive: true })
  const file = join(configDir, '.credentials.json')
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: `${CREDENTIAL}-${basename(configDir)}` } }, null, 2) + '\n', { mode: 0o600 })
  const doc = readJson(join(configDir, '.claude.json'))
  doc.oauthAccount = { ...account }
  writeJson(join(configDir, '.claude.json'), doc)
}

// the options of an auth call: --email takes its value and --text is a flag; any other option is ignored. Options come
// before `--` and positionals after it
function parse(argv: string[]): Parsed {
  const parsed: Parsed = { words: [], text: false }
  let afterDashes = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (afterDashes || !arg.startsWith('-')) parsed.words.push(arg)
    else if (arg === '--') afterDashes = true
    else if (arg === '--text') parsed.text = true
    else if (arg === '--email') parsed.email = argv[++i] ?? ''
    else if (arg.startsWith('--email=')) parsed.email = arg.slice('--email='.length)
  }
  return parsed
}

// `auth login`: says where to sign in, waits for the script's gate, then fails as scripted or writes the sign-in
async function login(parsed: Parsed, ctx: CliContext, spec: FakeAuth): Promise<number> {
  say('Opening the browser to sign in…')
  say('If it did not open, use this link: https://claude.ai/oauth/authorize?fake=1')
  if (spec.gate !== undefined) {
    while (!existsSync(join(ctx.configDir, spec.gate))) await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (spec.fail !== undefined) return complain(`Login failed: ${spec.fail}`)
  // the signed-in email: the script's when it gives one (the person a test scripts), else --email (the page's pre-fill), else the folder's default
  signIn(ctx.configDir, accountOf(basename(ctx.configDir), { ...spec, email: spec.email ?? parsed.email }))
  say('Login successful.')
  return 0
}

// `auth status`: the signed-in JSON (or `Logged in as …` with --text), or the signed-out answer with exit 1
async function status(parsed: Parsed, ctx: CliContext, spec: FakeAuth): Promise<number> {
  if (spec.status === 'garbage') {
    say('Welcome to Claude Code')
    return 0
  }
  if (spec.status === 'hang') {
    // never answers: the interval keeps the process alive until its caller ends it
    setInterval(() => {}, 1000)
    return new Promise<number>(() => {})
  }
  const account = readJson(join(ctx.configDir, '.claude.json')).oauthAccount as Json | undefined
  const signedIn = existsSync(join(ctx.configDir, '.credentials.json')) && typeof account === 'object' && account !== null
  if (!signedIn) {
    if (parsed.text) say('Not logged in')
    else say(JSON.stringify({ loggedIn: false, authMethod: 'none', configDirectory: ctx.configDir }))
    return 1
  }
  if (parsed.text) {
    say(`Logged in as ${account.emailAddress}`)
    return 0
  }
  say(
    JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      configDirectory: ctx.configDir,
      email: account.emailAddress,
      orgId: account.organizationUuid,
      orgName: account.organizationName,
      subscriptionType: String(account.organizationType).replace(/^claude_/, '')
    })
  )
  return 0
}

// `auth logout`: removes the token and the account, keeps the other keys of .claude.json
function logout(ctx: CliContext): number {
  rmSync(join(ctx.configDir, '.credentials.json'), { force: true })
  const file = join(ctx.configDir, '.claude.json')
  const doc = readJson(file)
  if ('oauthAccount' in doc) {
    delete doc.oauthAccount
    writeJson(file, doc)
  }
  say('Successfully logged out')
  return 0
}

async function auth(parsed: Parsed, ctx: CliContext): Promise<number> {
  const sub = parsed.words[1]
  // the script's sign-in of this folder, by its name; none: the defaults
  const spec: FakeAuth = ctx.script.auth?.[basename(ctx.configDir)] ?? {}
  if (sub === 'login') return login(parsed, ctx, spec)
  if (sub === 'status') return status(parsed, ctx, spec)
  if (sub === 'logout') return logout(ctx)
  return unknown(sub)
}

async function dispatch(parsed: Parsed, ctx: CliContext): Promise<number> {
  const [group] = parsed.words
  if (group === 'auth') return auth(parsed, ctx)
  return unknown(group)
}

// runs one `claude auth` call and resolves to its exit code; the call is logged first, never a secret value
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  ctx.log({ cli: argv, secretEnv: process.env.MCP_CLIENT_SECRET !== undefined, stdinKeys: null })
  const message = failure(argv, ctx.script)
  if (message !== undefined) return complain(message)
  try {
    return await dispatch(parse(argv), ctx)
  } catch (error) {
    return complain(`error: ${(error as Error).message}`)
  }
}
