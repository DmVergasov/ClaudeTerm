import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chatStandIn, sendMessage } from './chat-helpers'
import { FAKE_CLAUDE_SETTINGS, launchApp, writeTranscript, type Launched } from './helpers'

const SID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'

/**
 * The machine's own Claude Code, as the shell a person runs the tests from sets it up: CLAUDE_CONFIG_DIR at a config folder
 * signed in on a Max plan, with a conversation, that trusts the work folder; a home folder with a ~/.claude.json and a
 * ~/.claude of its own; a sign-in key; and the pipe and tab of the ClaudeTerm the shell runs in. All of it invented, in a temp folder.
 */
function machineClaude(work: string): { root: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'ct-machine-'))
  const config = join(root, 'account')
  const home = join(root, 'home')
  mkdirSync(config, { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  const claudeJson = JSON.stringify({
    oauthAccount: { emailAddress: 'machine@example.com', organizationType: 'claude_max' },
    projects: { [realpathSync.native(work)]: { hasTrustDialogAccepted: true } }
  })
  writeFileSync(join(config, '.claude.json'), claudeJson)
  writeFileSync(join(home, '.claude.json'), claudeJson)
  writeTranscript(config, work, SID)
  writeTranscript(join(home, '.claude'), work, SID)
  return {
    root,
    env: {
      CLAUDE_CONFIG_DIR: config,
      HOME: home,
      USERPROFILE: home,
      ANTHROPIC_API_KEY: 'sk-ant-machine-key-0001',
      CLAUDE_CODE_OAUTH_TOKEN: 'machine-oauth-token-0001',
      CLAUDETERM_PIPE: 'claudeterm-machine-pipe',
      CLAUDETERM_TAB_ID: '0f1e2d3c-4b5a-4968-8776-655443322110'
    }
  }
}

/** launches the app from a test process whose environment holds the machine's variables, as one started from that shell does */
async function launchAsMachine(machine: Record<string, string>, launch: () => Promise<Launched>): Promise<Launched> {
  const saved = Object.fromEntries(Object.keys(machine).map((key) => [key, process.env[key]]))
  Object.assign(process.env, machine)
  try {
    return await launch()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** every file and folder under the folder with its size and time: a write anywhere in it, even of a file deleted since, changes them */
function contents(dir: string): string[] {
  const names = ['.', ...readdirSync(dir, { recursive: true }).map(String)]
  return names.map((name) => {
    const s = statSync(join(dir, name))
    return `${name} ${s.isDirectory() ? 'dir' : s.size} ${s.mtimeMs}`
  }).sort()
}

test('the app a test starts reads nothing of the Claude Code and ClaudeTerm the machine\'s environment points at', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const machine = machineClaude(work)
  const before = contents(machine.root)
  const folder = mkdtempSync(join(tmpdir(), 'ct-folder-'))
  const { app, page } = await launchAsMachine(machine.env, () => launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: folder, tabs: { position: 'left' } } }))
  try {
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    // Main account's login is unknown to a test: the foot names Claude Code's login, not the machine's Max plan
    await expect.soft(page.locator('#tabpanel .tp-account-name')).toHaveText('Main account')
    await expect.soft(page.locator('#tabpanel .tp-account-plan')).toHaveText('Claude Code login')
    // and Recent sessions lists none of the machine's conversations
    expect.soft(await page.evaluate(() => window.ct.listSessions())).toEqual([])
    // the app and what it starts see none of the machine's variables, and a home folder of the run's own
    const env = await app.evaluate(() => ({
      config: process.env.CLAUDE_CONFIG_DIR ?? null,
      key: process.env.ANTHROPIC_API_KEY ?? null,
      token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      pipe: process.env.CLAUDETERM_PIPE ?? null,
      tab: process.env.CLAUDETERM_TAB_ID ?? null,
      homes: [process.env.HOME, process.env.USERPROFILE].map((h) => h ?? null)
    }))
    expect.soft(env).toEqual({ config: null, key: null, token: null, pipe: null, tab: null, homes: env.homes })
    expect.soft(env.homes.map((h) => (h === null ? null : dirname(h)))).toEqual([tmpdir(), tmpdir()])
  } finally {
    await app.close()
  }
  expect(contents(machine.root)).toEqual(before)
})

test('the Claude Code a test\'s chat starts writes nothing into the config folder the machine\'s environment points at', async () => {
  const stand = chatStandIn({ turns: { hello: [{ text: 'Hi there' }] } })
  const machine = machineClaude(stand.work)
  const before = contents(machine.root)
  // the test's own home, without CLAUDE_CONFIG_DIR: its .claude.json trusts the work folder, and Claude Code keeps the
  // conversation in its .claude
  const home = join(dirname(stand.config), 'home')
  mkdirSync(home)
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [realpathSync.native(stand.work)]: { hasTrustDialogAccepted: true } } }))
  const { CLAUDE_CONFIG_DIR: _own, ...standIn } = stand.env
  const { app, page } = await launchAsMachine(machine.env, () => launchApp({ settings: stand.settings, args: stand.args, env: { ...standIn, HOME: home, USERPROFILE: home } }))
  try {
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    await sendMessage(page, 'hello')
    await expect(page.locator('.chat-column')).toContainText('Hi there')
    // the conversation is kept in the test's own home
    const kept = join(home, '.claude', 'projects', realpathSync.native(stand.work).replace(/[^a-zA-Z0-9]/g, '-'))
    await expect.soft.poll(() => (existsSync(kept) ? readdirSync(kept).filter((name) => name.endsWith('.jsonl')).length : 0)).toBe(1)
  } finally {
    await app.close()
  }
  expect(contents(machine.root)).toEqual(before)
})
