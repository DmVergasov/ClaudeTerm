import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatReady, launchChatTab } from './chat-helpers'
import { chatStarts, cliCalls, readJsonFile } from './mcp-helpers'

// The MCP servers backend in the app: the servers a chat tab lists, adding one through Claude Code's CLI, and a sign-in that
// reconnects the server in the running session. The stand-in Claude Code answers for the session and the CLI.

const SENTRY = { type: 'http', url: 'https://mcp.example.com/sentry' }

/** a work folder with a project .mcp.json, made before the app starts */
function projectWork(): string {
  const work = mkdtempSync(join(tmpdir(), 'ct-mcp-work-'))
  writeFileSync(join(work, '.mcp.json'), JSON.stringify({ mcpServers: { postgres: { command: 'fake-postgres', args: [] } } }))
  return work
}

test('the servers of a chat tab come from its running session and its configuration', async () => {
  const { app, page, tabId } = await launchChatTab(
    { turns: {}, mcp: { github: { tools: ['a', 'b', 'c'], version: '1.4.2' } } },
    { work: projectWork(), claude: { mcpServers: { github: { type: 'http', url: 'https://example.com/github' } } } }
  )
  try {
    await chatReady(page)
    await expect.poll(async () => (await page.evaluate((id) => window.ct.mcpServers(id), tabId))?.live ?? null).toBe(true)
    const view = await page.evaluate((id) => window.ct.mcpServers(id), tabId)
    expect(view!.servers.find((s) => s.name === 'github')).toMatchObject({ status: 'connected', scope: 'user', tools: ['a', 'b', 'c'], version: '1.4.2' })
    expect(view!.servers.find((s) => s.name === 'postgres')).toMatchObject({ status: 'pending-approval', scope: 'project' })
  } finally {
    await app.close()
  }
})

test('ct.mcpAdd adds through Claude Code in the scope asked', async () => {
  const { app, page, tabId, config, log } = await launchChatTab({ turns: {} })
  try {
    await chatReady(page)
    const text = JSON.stringify({ mcpServers: { context7: { type: 'http', url: 'https://example.com/context7' } } })
    const result = await page.evaluate(({ id, text }) => window.ct.mcpAdd(id, { text, names: ['context7'], scope: 'user', clientSecret: null }), { id: tabId, text })
    expect(result).toEqual({ ok: true })
    expect(readJsonFile(join(config, '.claude.json')).mcpServers.context7).toEqual({ type: 'http', url: 'https://example.com/context7', headers: {} })
    const last = cliCalls(log).at(-1)!
    expect(last.argv).toEqual(['mcp', 'add-json', '--scope', 'user', '--', 'context7', JSON.stringify({ type: 'http', url: 'https://example.com/context7', headers: {} })])
    expect(last.secretEnv).toBe(false)
  } finally {
    await app.close()
  }
})

test('an OAuth client secret goes in the environment, never in the arguments', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: {} })
  try {
    await chatReady(page)
    const text = JSON.stringify({ mcpServers: { sentry: { type: 'http', url: 'https://mcp.example.com/sentry', oauth: { clientId: 'client-abc' } } } })
    const result = await page.evaluate(({ id, text }) => window.ct.mcpAdd(id, { text, names: ['sentry'], scope: 'user', clientSecret: 'cs-123' }), { id: tabId, text })
    expect(result).toEqual({ ok: true })
    const last = cliCalls(log).at(-1)!
    expect(last.secretEnv).toBe(true)
    expect(last.argv).toContain('--client-secret')
    expect(last.argv.some((arg) => arg.includes('cs-123'))).toBe(false)
  } finally {
    await app.close()
  }
})

test('a sign-in reconnects the server in the running session and does not restart it', async () => {
  const { app, page, tabId, config, log } = await launchChatTab(
    { turns: {}, mcp: { sentry: { status: 'needs-auth' } }, mcpLogin: { sentry: { gate: 'sentry-ok' } } },
    { claude: { mcpServers: { sentry: SENTRY } } }
  )
  try {
    await chatReady(page)
    await expect.poll(async () => (await page.evaluate((id) => window.ct.mcpServers(id), tabId))?.servers.find((s) => s.name === 'sentry')?.status ?? null).toBe('needs-auth')
    let answered = false
    const login = page.evaluate((id) => window.ct.mcpAction(id, { kind: 'login', name: 'sentry' }), tabId).then((r) => {
      answered = true
      return r
    })
    // the browser sign-in is not done: the call waits for it
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(answered).toBe(false)
    writeFileSync(join(config, 'sentry-ok'), '')
    expect(await login).toEqual({ ok: true })
    expect(log().some((e) => JSON.stringify(e).includes('mcp_reconnect') && JSON.stringify(e).includes('sentry'))).toBe(true)
    await expect.poll(async () => (await page.evaluate((id) => window.ct.mcpServers(id), tabId))?.servers.find((s) => s.name === 'sentry')?.status ?? null).toBe('connected')
    expect(chatStarts(log)).toBe(1)
  } finally {
    await app.close()
  }
})

test('with no running session a session action says so', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: {}, beforeInit: [{ crash: 1 }] }, { claude: { mcpServers: { sentry: SENTRY } } })
  try {
    await expect.poll(async () => (await page.evaluate((id) => window.ct.mcpServers(id), tabId))?.live ?? null).toBe(false)
    const view = await page.evaluate((id) => window.ct.mcpServers(id), tabId)
    expect(view!.servers.find((s) => s.name === 'sentry')).toMatchObject({ status: 'configured', scope: 'user' })
    expect(await page.evaluate((id) => window.ct.mcpAction(id, { kind: 'reconnect', name: 'sentry' }), tabId)).toEqual({ ok: false, error: 'Claude Code is not running in this tab' })
  } finally {
    await app.close()
  }
})

test('an unknown tab gets null', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    expect(await page.evaluate(() => window.ct.mcpServers('no-such-tab'))).toBeNull()
  } finally {
    await app.close()
  }
})
