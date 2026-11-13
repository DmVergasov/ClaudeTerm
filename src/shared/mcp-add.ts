// What a person pastes to add an MCP server, read the same way by the window (what is shown) and main (what is added)

import { MCP_EDIT_SCOPES, type McpEditScope } from './mcp'

export type McpConfig =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string>; oauth?: McpOauth }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string>; oauth?: McpOauth }
export interface McpOauth { clientId?: string; callbackPort?: number }
export interface ParsedServer { name: string; config: McpConfig }
export type AddParse =
  | { kind: 'servers'; servers: ParsedServer[]; scope: McpEditScope | null; needsClientSecret: boolean }  // scope: named by the command (-s / --scope)
  | { kind: 'github'; source: string }                       // a GitHub repository link: a plugin marketplace, not a server
  | { kind: 'none'; reason: string }

export const MASK = '••••••••'

const MAX_TEXT = 65536
const MAX_SERVERS = 20
const EMPTY_REASON = 'Paste a command, a server URL or a JSON config'
const TOO_LONG_REASON = 'The text is too long'
const NOT_RECOGNISED_REASON = 'Not a claude mcp add command, a URL or a JSON config'
const QUOTE_REASON = 'A quote is not closed'
const HTTP_ONLY_REASON = 'Only http and https addresses'
const MANY_REASON = 'At most 20 servers at once'
const JSON_REASON = 'The JSON does not parse: '
const RUNNERS = ['npx', 'uvx', 'bunx', 'node', 'python', 'python3', 'docker', 'deno']
const SECRET_NAME = /key|token|secret|password|auth/i

/** Thrown inside the parser for text that is refused; parseAddInput turns it into a `none` result */
class Refusal extends Error {}

function refuse(reason: string): never {
  throw new Refusal(reason)
}

export function parseAddInput(text: string): AddParse {
  try {
    return parseText(text)
  } catch (error) {
    if (error instanceof Refusal) return { kind: 'none', reason: error.message }
    return { kind: 'none', reason: NOT_RECOGNISED_REASON }
  }
}

function parseText(text: string): AddParse {
  const trimmed = text.trim()
  if (trimmed === '') refuse(EMPTY_REASON)
  if (trimmed.length > MAX_TEXT) refuse(TOO_LONG_REASON)
  if (trimmed.startsWith('{')) return { kind: 'servers', servers: servers(parseJson(trimmed)), scope: null, needsClientSecret: false }

  // a line ending in a backslash continues on the next line; a leading "$ " or "> " is a shell prompt
  const line = trimmed.replace(/\r\n/g, '\n').replace(/\\[ \t]*\n/g, ' ').replace(/^[$>] /, '')
  if (line.includes('\n')) refuse(NOT_RECOGNISED_REASON)
  const words = splitCommandLine(line)
  if (words === null) refuse(QUOTE_REASON)
  if (words.length === 0 || words[0] === '') refuse(NOT_RECOGNISED_REASON)

  if (words.length === 1) {
    const github = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/\S*)?$/i.exec(words[0])
    if (github) return { kind: 'github', source: `${github[1]}/${github[2]}` }
    if (isHttpUrl(words[0])) return { kind: 'servers', servers: [{ name: nameFromUrl(words[0]), config: { type: 'http', url: words[0], headers: {} } }], scope: null, needsClientSecret: false }
    if (hasScheme(words[0])) refuse(HTTP_ONLY_REASON)
  }

  if (isClaude(words[0])) {
    if (words[1] !== 'mcp') refuse(NOT_RECOGNISED_REASON)
    if (words[2] === 'add-json') return parseAddJson(words.slice(3))
    if (words[2] === 'add') return parseAdd(words.slice(3))
    refuse(NOT_RECOGNISED_REASON)
  }

  // any other command line: a stdio server
  const [command, ...args] = words
  return { kind: 'servers', servers: [{ name: nameFromCommand(args), config: { type: 'stdio', command, args, env: {} } }], scope: null, needsClientSecret: false }
}

/** splits a command line by POSIX rules: '…' literal, "…" with \" and \\, \ escapes outside quotes; null when a quote is not closed */
export function splitCommandLine(line: string): string[] | null {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) word += line[++i]
      else word += ch
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(word)
      word = ''
      inWord = false
      continue
    }
    inWord = true
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '\\' && i + 1 < line.length) word += line[++i]
    else word += ch
  }
  if (quote !== null) return null
  if (inWord) words.push(word)
  return words
}

export function isServerName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)
}

/** the name as typed when it is valid; otherwise its valid characters (up to 64), or 'server' */
function cleanName(raw: string): string {
  if (isServerName(raw)) return raw
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, '').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64)
  return cleaned === '' ? 'server' : cleaned
}

function isClaude(word: string): boolean {
  return /(^|[\\/])claude(\.exe|\.cmd)?$/i.test(word)
}

function isHttpUrl(text: string): boolean {
  return /^https?:\/\//i.test(text)
}

function hasScheme(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
}

function parseAddJson(rest: string[]): AddParse {
  if (rest.length < 2) refuse(NOT_RECOGNISED_REASON)
  const config = configOf(parseJson(rest.slice(1).join(' ')))
  return { kind: 'servers', servers: [{ name: cleanName(rest[0]), config }], scope: null, needsClientSecret: false }
}

function parseAdd(rest: string[]): AddParse {
  let scope: McpEditScope | null = null
  let transport: 'stdio' | 'http' | 'sse' | null = null
  let needsClientSecret = false
  let clientId: string | undefined
  let callbackPort: number | undefined
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  let hasEnv = false
  let hasHeaders = false
  const positional: string[] = []
  let afterDashes: string[] = []

  let i = 0
  while (i < rest.length) {
    const word = rest[i]
    if (word === '--') {
      afterDashes = rest.slice(i + 1)
      break
    }
    if (word === '-s' || word === '--scope') {
      const value = rest[i + 1]
      if (!MCP_EDIT_SCOPES.includes(value as McpEditScope)) refuse(NOT_RECOGNISED_REASON)
      scope = value as McpEditScope
      i += 2
    } else if (word === '-t' || word === '--transport') {
      const value = rest[i + 1]
      if (value !== 'stdio' && value !== 'http' && value !== 'sse') refuse(NOT_RECOGNISED_REASON)
      transport = value
      i += 2
    } else if (word === '-e' || word === '--env') {
      // every following KEY=value word
      i++
      let count = 0
      while (i < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i])) {
        const at = rest[i].indexOf('=')
        env[rest[i].slice(0, at)] = rest[i].slice(at + 1)
        count++
        i++
      }
      if (count === 0) refuse(NOT_RECOGNISED_REASON)
      hasEnv = true
    } else if (word === '-H' || word === '--header') {
      // every following word that is a "Name: value" header; a URL is never a header
      i++
      let count = 0
      while (i < rest.length && isHeaderWord(rest[i])) {
        const at = rest[i].indexOf(':')
        headers[rest[i].slice(0, at).trim()] = rest[i].slice(at + 1).trim()
        count++
        i++
      }
      if (count === 0) refuse(NOT_RECOGNISED_REASON)
      hasHeaders = true
    } else if (word === '--client-id') {
      clientId = rest[i + 1]
      if (clientId === undefined) refuse(NOT_RECOGNISED_REASON)
      i += 2
    } else if (word === '--callback-port') {
      callbackPort = Number(rest[i + 1])
      if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535) refuse(NOT_RECOGNISED_REASON)
      i += 2
    } else if (word === '--client-secret') {
      needsClientSecret = true
      i++
    } else if (word.startsWith('-')) {
      refuse(NOT_RECOGNISED_REASON)
    } else {
      positional.push(word)
      i++
    }
  }

  const name = positional[0]
  if (name === undefined) refuse(NOT_RECOGNISED_REASON)
  const tail = [...positional.slice(1), ...afterDashes]
  const target = tail[0]
  if (target === undefined) refuse(NOT_RECOGNISED_REASON)
  const args = tail.slice(1)

  if (!isHttpUrl(target) && hasScheme(target)) refuse(HTTP_ONLY_REASON)
  const kind = transport ?? (isHttpUrl(target) ? 'http' : 'stdio')
  const oauth: McpOauth | undefined = clientId === undefined && callbackPort === undefined
    ? undefined
    : { ...(clientId === undefined ? {} : { clientId }), ...(callbackPort === undefined ? {} : { callbackPort }) }

  let config: McpConfig
  if (kind === 'stdio') {
    if (hasHeaders) refuse(NOT_RECOGNISED_REASON)
    config = { type: 'stdio', command: target, args, env, ...(oauth ? { oauth } : {}) }
  } else {
    if (!isHttpUrl(target) || args.length > 0 || hasEnv) refuse(NOT_RECOGNISED_REASON)
    config = { type: kind, url: target, headers, ...(oauth ? { oauth } : {}) }
  }

  return {
    kind: 'servers',
    servers: [{ name: cleanName(name), config }],
    scope,
    needsClientSecret,
  }
}

/** a header word: "Name: value", not an http(s) URL */
function isHeaderWord(word: string): boolean {
  return word.includes(':') && !isHttpUrl(word)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    refuse(JSON_REASON + ((error as Error).message ?? '').slice(0, 200))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** every value an object with command or url: a set of named configs */
function isNamedSet(value: Record<string, unknown>): boolean {
  const entries = Object.values(value)
  return entries.length > 0 && entries.every((entry) => isRecord(entry) && ('command' in entry || 'url' in entry))
}

function servers(value: unknown): ParsedServer[] {
  if (!isRecord(value)) refuse(NOT_RECOGNISED_REASON)
  let named: Record<string, unknown> | null = null
  if (isRecord(value.mcpServers)) named = value.mcpServers
  else if (isRecord(value.servers)) named = value.servers
  else if (isNamedSet(value)) named = value

  if (named === null) {
    // one bare config, named from its host or its command
    const config = configOf(value)
    return [{ name: cleanName(nameOf(config)), config }]
  }
  const list = Object.entries(named).map(([name, entry]) => ({ name: cleanName(name), config: configOf(entry) }))
  if (list.length === 0) refuse(NOT_RECOGNISED_REASON)
  if (list.length > MAX_SERVERS) refuse(MANY_REASON)
  return list
}

/** a JSON config: type stdio | http | sse (default stdio with command, http with url); other keys dropped */
function configOf(raw: unknown): McpConfig {
  if (!isRecord(raw)) refuse(NOT_RECOGNISED_REASON)
  const type = raw.type ?? (typeof raw.command === 'string' ? 'stdio' : 'http')
  const oauth = oauthOf(raw.oauth)
  if (type === 'stdio') {
    if (typeof raw.command !== 'string') refuse(NOT_RECOGNISED_REASON)
    return { type, command: raw.command, args: stringList(raw.args), env: stringRecord(raw.env), ...(oauth ? { oauth } : {}) }
  }
  if (type === 'http' || type === 'sse') {
    if (typeof raw.url !== 'string') refuse(NOT_RECOGNISED_REASON)
    if (!isHttpUrl(raw.url)) refuse(hasScheme(raw.url) ? HTTP_ONLY_REASON : NOT_RECOGNISED_REASON)
    return { type, url: raw.url, headers: stringRecord(raw.headers), ...(oauth ? { oauth } : {}) }
  }
  return refuse(NOT_RECOGNISED_REASON)
}

function stringList(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) refuse(NOT_RECOGNISED_REASON)
  return value as string[]
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === 'string')) refuse(NOT_RECOGNISED_REASON)
  return { ...(value as Record<string, string>) }
}

function oauthOf(value: unknown): McpOauth | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) refuse(NOT_RECOGNISED_REASON)
  const oauth: McpOauth = {}
  if (value.clientId !== undefined) {
    if (typeof value.clientId !== 'string') refuse(NOT_RECOGNISED_REASON)
    oauth.clientId = value.clientId
  }
  if (value.callbackPort !== undefined) {
    if (typeof value.callbackPort !== 'number') refuse(NOT_RECOGNISED_REASON)
    oauth.callbackPort = value.callbackPort
  }
  return oauth
}

function nameOf(config: McpConfig): string {
  return config.type === 'stdio' ? nameFromCommand(config.args) : nameFromUrl(config.url)
}

/** the host without a leading mcp., api. or www., its first label: mcp.context7.com → context7 */
function nameFromUrl(url: string): string {
  const host = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]*)/i.exec(url)?.[1] ?? ''
  const label = host.replace(/^(?:mcp|api|www)\./i, '').split('.')[0]
  return label === '' ? 'server' : label
}

/** the first argument that is not an option and not a runner, without its @scope/ and @version: npx -y @upstash/context7-mcp → context7-mcp */
function nameFromCommand(args: string[]): string {
  const found = args.find((arg) => !arg.startsWith('-') && !RUNNERS.includes(arg))
  if (found === undefined) return 'server'
  return found.replace(/^@[^/]*\//, '').replace(/(.)@[^@]*$/, '$1').toLowerCase()
}

/** a secret-looking query value (key, token, secret, password, auth) → MASK */
export function maskUrl(url: string): string {
  return url.replace(/([?&][^=&#]*?)=([^&#]*)/g, (match, name: string, value: string) =>
    SECRET_NAME.test(name.slice(1)) && value !== '' ? `${name}=${MASK}` : match)
}

/** every header and env value, non-empty */
export function secretsOf(config: McpConfig): string[] {
  const values = config.type === 'stdio' ? Object.values(config.env) : Object.values(config.headers)
  return values.filter((value) => value !== '')
}

/** each secret replaced by MASK, longest first */
export function maskText(text: string, secrets: string[]): string {
  return [...secrets]
    .filter((secret) => secret !== '')
    .sort((a, b) => b.length - a.length)
    .reduce((masked, secret) => masked.split(secret).join(MASK), text)
}

/** the URL (secret query values masked), or the command and its args joined by spaces (an arg with a space in double quotes) */
export function targetOf(config: McpConfig): string {
  if (config.type !== 'stdio') return maskUrl(config.url)
  return [config.command, ...config.args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))].join(' ')
}

/** the config with every header and env value as MASK and the URL masked: what the panel copies */
export function maskedConfig(config: McpConfig): McpConfig {
  if (config.type === 'stdio') {
    return { ...config, env: maskRecord(config.env) }
  }
  return { ...config, url: maskUrl(config.url), headers: maskRecord(config.headers) }
}

function maskRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).map((key) => [key, MASK]))
}

/** the rows the dialog shows before adding: the name is not a row (the dialog edits it) */
export function previewRows(s: ParsedServer): { label: string; value: string }[] {
  const config = s.config
  const rows: { label: string; value: string }[] = []
  if (config.type === 'stdio') {
    rows.push({ label: 'Type', value: 'stdio' }, { label: 'Command', value: targetOf(config) })
    for (const key of Object.keys(config.env)) rows.push({ label: 'Env', value: `${key}=${MASK}` })
  } else {
    rows.push({ label: 'Type', value: config.type === 'http' ? 'HTTP' : 'SSE' }, { label: 'Address', value: maskUrl(config.url) })
    for (const key of Object.keys(config.headers)) rows.push({ label: 'Header', value: `${key}: ${MASK}` })
  }
  if (config.oauth?.clientId !== undefined) rows.push({ label: 'OAuth client', value: config.oauth.clientId })
  return rows
}
