import { expect, test } from '@playwright/test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAT_INPUT, chatReady, launchChatTab, userMessages } from './chat-helpers'
import { bufferText, keepingClipboard } from './helpers'
import { chatStarts, cliCalls } from './mcp-helpers'

// The MCP · Plugins panel of a Claude tab's chat: its button, the /mcp and /plugin commands, the servers grouped by what they need,
// and the filter. The stand-in Claude Code answers for the session and the configuration folder holds the servers.

const PANEL = '.panel-mcp'
const TOGGLE = '.tab-mcp-toggle'
const GROUP_HEAD = '.panel-mcp .mcp-group-head'
const FILTER = '.panel-mcp .mcp-filter'
const GITHUB = { type: 'http', url: 'https://example.com/github' }
const SENTRY = { type: 'http', url: 'https://mcp.example.com/sentry' }
const MEMORY = { type: 'stdio', command: 'fake-memory' }

/** a work folder with a project .mcp.json of one server, made before the app starts; its real path is the key of its trust entry */
function projectWork(): string {
  const work = mkdtempSync(join(tmpdir(), 'ct-mcp-panel-'))
  writeFileSync(join(work, '.mcp.json'), JSON.stringify({ mcpServers: { postgres: { command: 'fake-postgres', args: [] } } }))
  return work
}

test('the header button opens MCP · Plugins beside the chat and closes it', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    await expect(page.locator(PANEL)).toBeVisible()
    await expect(page.locator('#image-panel .panel-title')).toHaveText('MCP · Plugins')
    await expect.poll(async () => (await page.locator('#image-panel').boundingBox())?.width ?? 0).toBeCloseTo(420, 0)
    await page.locator(TOGGLE).click()
    await expect(page.locator('#image-panel')).toHaveClass(/collapsed/)
  } finally {
    await app.close()
  }
})

test('/mcp opens the servers and sends nothing to Claude Code', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await chatReady(page)
    await page.locator(CHAT_INPUT).click()
    await page.keyboard.type('/mcp')
    await page.keyboard.press('Enter')
    await expect(page.locator(PANEL)).toBeVisible()
    await expect(page.locator(CHAT_INPUT)).toHaveValue('')
    await expect(page.locator(FILTER)).toBeFocused()
    expect(userMessages(log)).not.toContain('/mcp')
  } finally {
    await app.close()
  }
})

test('/plugin opens the panel on Plugins', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await chatReady(page)
    await page.locator(CHAT_INPUT).click()
    await page.keyboard.type('/plugin')
    await page.keyboard.press('Enter')
    await expect(page.locator(PANEL)).toBeVisible()
    await expect(page.locator('.panel-mcp [data-section="plugins"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.panel-mcp .mcp-hint')).toHaveText('Installs and changes restart the session')
    expect(userMessages(log)).not.toContain('/plugin')
  } finally {
    await app.close()
  }
})

test('servers are grouped by what they need, with their source, tools and error', async () => {
  const work = projectWork()
  const real = realpathSync.native(work)
  const { app, page } = await launchChatTab(
    {
      turns: {},
      mcp: {
        github: { tools: ['search', 'read', 'write'], version: '1.4.2' },
        sentry: { status: 'needs-auth' },
        postgres: { status: 'failed', error: 'spawn uvx ENOENT' }
      }
    },
    {
      work,
      claude: {
        mcpServers: { github: GITHUB, sentry: SENTRY, memory: MEMORY },
        projects: { [real]: { enabledMcpjsonServers: ['postgres'], disabledMcpServers: ['memory'] } }
      }
    }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    await expect(page.locator(GROUP_HEAD)).toHaveText(['NEEDS ATTENTION', 'CONNECTED', 'OFF'])
    const first = page.locator('.panel-mcp .mcp-group').nth(0)
    await expect(first.locator('[data-name="sentry"]')).toHaveCount(1)
    await expect(first.locator('[data-name="postgres"]')).toHaveCount(1)
    const github = page.locator('.panel-mcp [data-name="github"]')
    await expect(github).toContainText('User')
    await expect(github).toContainText('3 tools · v1.4.2')
    await expect(page.locator('.panel-mcp .mcp-error')).toHaveText('spawn uvx ENOENT')
    await expect(page.locator('.panel-mcp .mcp-group').nth(2).locator('[data-name="memory"]')).toHaveCount(1)
    await expect(page.locator('.panel-mcp .mcp-stat-value')).toHaveText(['1', '1', '1'])
  } finally {
    await app.close()
  }
})

test('the filter finds a server by one of its tools, and Esc clears it', async () => {
  const { app, page } = await launchChatTab(
    { turns: {}, mcp: { github: { tools: ['search_issues', 'create_gist'] }, sentry: { status: 'needs-auth' } } },
    { claude: { mcpServers: { github: GITHUB, sentry: SENTRY } } }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    await expect(page.locator('.panel-mcp [data-name="sentry"]')).toHaveCount(1)
    await page.locator(FILTER).fill('gist')
    await expect(page.locator('.panel-mcp [data-name="sentry"]')).toHaveCount(0)
    await expect(page.locator('.panel-mcp [data-name="github"] .mcp-chip')).toHaveText(['create_gist'])
    await page.locator(FILTER).press('Escape')
    await expect(page.locator(FILTER)).toHaveValue('')
    await expect(page.locator('.panel-mcp [data-name="sentry"]')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('with no running session the panel lists the configured servers', async () => {
  const { app, page } = await launchChatTab({ turns: {}, beforeInit: [{ crash: 1 }] }, { claude: { mcpServers: { sentry: SENTRY } } })
  try {
    await page.locator(TOGGLE).click()
    await expect(page.locator('.panel-mcp .mcp-note')).toContainText('Claude Code is not running in this tab: statuses show once it runs')
    await expect(page.locator(GROUP_HEAD)).toHaveText(['CONFIGURED'])
    await expect(page.locator('.panel-mcp [data-name="sentry"]')).toHaveCount(1)
    await expect(page.locator('.panel-mcp [role="switch"]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a row keeps the focus when Enter opens its tools', async () => {
  const { app, page } = await launchChatTab({ turns: {}, mcp: { github: { tools: ['search', 'read'] } } }, { claude: { mcpServers: { github: GITHUB } } })
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const name = page.locator('.panel-mcp [data-name="github"] .mcp-main')
    await expect(name).toBeVisible()
    await name.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.panel-mcp [data-name="github"] .mcp-chip')).toHaveText(['search', 'read'])
    // the list is drawn again when the tools open: the same row's name button has the focus again
    await expect(name).toBeFocused()
    await expect(name).toHaveAttribute('aria-expanded', 'true')
  } finally {
    await app.close()
  }
})

test('a terminal-view tab has no MCP button', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await chatReady(page)
    await expect(page.locator(TOGGLE)).toBeVisible()
    await page.locator('.sh-mode[data-view="terminal"]').click()
    await expect(page.locator(TOGGLE)).toBeHidden()
  } finally {
    await app.close()
  }
})

const ROW = (name: string) => `.panel-mcp [data-name="${name}"]`
const LOGIN_GATE = { mcpLogin: { sentry: { gate: 'sentry-ok' } } }

test('Sign in waits for the browser, then reconnects the server in the running session', async () => {
  const { app, page, config, log } = await launchChatTab(
    { turns: {}, mcp: { sentry: { status: 'needs-auth' } }, ...LOGIN_GATE },
    { claude: { mcpServers: { sentry: SENTRY } } }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('sentry'))
    await row.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(row).toContainText('Waiting for the browser…')
    await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    writeFileSync(join(config, 'sentry-ok'), '')
    await expect(row.locator('.mcp-row')).toHaveAttribute('data-status', 'connected')
    await expect(row).toContainText('1 tool')
    expect(JSON.stringify(log())).toContain('mcp_reconnect')
    expect(chatStarts(log)).toBe(1)
  } finally {
    await app.close()
  }
})

test('Cancel ends a sign-in', async () => {
  const { app, page, log } = await launchChatTab(
    { turns: {}, mcp: { sentry: { status: 'needs-auth' } }, ...LOGIN_GATE },
    { claude: { mcpServers: { sentry: SENTRY } } }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('sentry'))
    await row.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(row).toContainText('Waiting for the browser…')
    await row.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(row).not.toContainText('Waiting for the browser…')
    // a cancelled sign-in is not a failure: no error under the row
    await expect(page.locator('.panel-mcp .mcp-error')).toHaveCount(0)
    expect(JSON.stringify(log())).not.toContain('mcp_reconnect')
  } finally {
    await app.close()
  }
})

test('Retry reconnects a failed server', async () => {
  const { app, page, log } = await launchChatTab(
    { turns: {}, mcp: { sentry: { status: 'failed', error: 'spawn uvx ENOENT' } } },
    { claude: { mcpServers: { sentry: SENTRY } } }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('sentry'))
    await row.getByRole('button', { name: '↻ Retry', exact: true }).click()
    await expect.poll(() => JSON.stringify(log())).toContain('mcp_reconnect')
    // the retry answered without an error: only the server's own error is under the row
    await expect(row.locator('.mcp-error')).toHaveText('spawn uvx ENOENT')
  } finally {
    await app.close()
  }
})

test('Reconnect in the ··· menu reconnects the server and closes the menu', async () => {
  const { app, page, log } = await launchChatTab(
    { turns: {}, mcp: { sentry: { status: 'failed', error: 'spawn uvx ENOENT' } } },
    { claude: { mcpServers: { sentry: SENTRY } } }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('sentry'))
    await row.getByRole('button', { name: 'More for sentry', exact: true }).click()
    await page.locator('.panel-mcp .mcp-menu-item', { hasText: 'Reconnect' }).click()
    await expect.poll(() => JSON.stringify(log())).toContain('mcp_reconnect')
    await expect(page.locator('.panel-mcp .mcp-menu')).toHaveCount(0)
    await expect(row.getByRole('button', { name: 'More for sentry', exact: true })).toBeEnabled()
  } finally {
    await app.close()
  }
})

test('the ↻ button reconnects a connected server', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} }, { claude: { mcpServers: { github: GITHUB } } })
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    await page.locator(ROW('github')).getByRole('button', { name: 'Reconnect github', exact: true }).click()
    await expect.poll(() => JSON.stringify(log())).toContain('mcp_reconnect')
    // the reconnect is answered when the button is on again: then no error is under the row
    await expect(page.locator(ROW('github')).getByRole('button', { name: 'Reconnect github', exact: true })).toBeEnabled()
    await expect(page.locator(ROW('github')).locator('.mcp-error')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('the switch turns a server off in the running session without a restart', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} }, { claude: { mcpServers: { github: GITHUB } } })
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    await page.getByRole('switch', { name: 'Turn github off' }).click()
    await expect(page.getByRole('switch', { name: 'Turn github on' })).toHaveAttribute('aria-checked', 'false')
    await expect(page.locator(GROUP_HEAD)).toHaveText(['OFF'])
    expect(log().some((e) => JSON.stringify(e).includes('mcp_toggle') && JSON.stringify(e).includes('"enabled":false'))).toBe(true)
    expect(chatStarts(log)).toBe(1)
  } finally {
    await app.close()
  }
})

test('the ··· menu lists the row actions, closes on Esc and gives the focus back to its button', async () => {
  const { app, page } = await launchChatTab({ turns: {}, mcp: { github: { tools: ['search'] } } }, { claude: { mcpServers: { github: GITHUB } } })
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const more = page.locator(ROW('github')).getByRole('button', { name: 'More for github', exact: true })
    await more.click()
    await expect(page.locator('.panel-mcp .mcp-menu-item')).toHaveText(['Sign out', 'Show tools', 'Copy config', 'Open config file', 'Remove'])
    await expect(page.locator('.panel-mcp .mcp-menu-item').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('.panel-mcp .mcp-menu')).toHaveCount(0)
    await expect(more).toBeFocused()
  } finally {
    await app.close()
  }
})

test('Remove asks, then takes the server out and the session restarts', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} }, { claude: { mcpServers: { github: GITHUB } } })
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('github'))
    await row.getByRole('button', { name: 'More for github', exact: true }).click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(row).toContainText('Remove github?')
    expect(chatStarts(log)).toBe(1)
    await row.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.locator(ROW('github'))).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(2)
  } finally {
    await app.close()
  }
})

test('a failed command shows its message under the row, never as a toast', async () => {
  const { app, page } = await launchChatTab(
    { turns: {}, cliFail: { 'mcp remove': 'Permission denied: .mcp.json' } },
    { claude: { mcpServers: { github: GITHUB } } }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('github'))
    await row.getByRole('button', { name: 'More for github', exact: true }).click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await row.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(row.locator('.mcp-error')).toHaveText('Permission denied: .mcp.json')
    await expect(page.locator('.toast')).toHaveCount(0)
    await expect(row).toBeVisible()
  } finally {
    await app.close()
  }
})

test('Approve in the terminal opens the terminal with /mcp', async () => {
  const work = projectWork()
  const { app, page, tabId } = await launchChatTab({ turns: {} }, { work })
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    await page.locator(ROW('postgres')).getByRole('button', { name: 'Approve in the terminal', exact: true }).click()
    await expect.poll(() => bufferText(page, tabId), { timeout: 25_000 }).toContain('you said: /mcp')
  } finally {
    await app.close()
  }
})

// the clipboard is the machine's: the test is @alone, and keepingClipboard gives it back
test('Copy config copies the JSON with the secrets hidden', { tag: '@alone' }, async () => {
  const HEADERS = { type: 'http', url: 'https://example.com/github', headers: { Authorization: 'Bearer s3cret' } }
  const { app, page } = await launchChatTab({ turns: {} }, { claude: { mcpServers: { github: HEADERS } } })
  try {
    await keepingClipboard(app, async () => {
      // the text main hands to the clipboard is recorded as it is written, and still goes to the real clipboard: some sessions
      // do not read back what they are given, so the record is what the test checks
      await app.evaluate(({ clipboard }) => {
        const copies: string[] = []
        ;(globalThis as Record<string, unknown>).__copies = copies
        const write = clipboard.writeText.bind(clipboard)
        clipboard.writeText = async (text: string) => { copies.push(text); write(text) }
      })
      await chatReady(page)
      await page.locator(TOGGLE).click()
      await page.locator(ROW('github')).getByRole('button', { name: 'More for github', exact: true }).click()
      await page.getByRole('button', { name: 'Copy config', exact: true }).click()
      // the row's controls are off while the copy runs: once they are on again, the answer is in and no error is under the row
      await expect(page.locator(ROW('github')).getByRole('button', { name: 'More for github', exact: true })).toBeEnabled()
      await expect(page.locator(ROW('github')).locator('.mcp-error')).toHaveCount(0)
      const copies = await app.evaluate(() => (globalThis as Record<string, unknown>).__copies as string[])
      expect(copies).toHaveLength(1)
      expect(copies[0]).toContain('"Authorization": "••••••••"')
      expect(copies[0]).not.toContain('s3cret')
    })
  } finally {
    await app.close()
  }
})

test('Open config file opens the scope\'s file', async () => {
  const { app, page, config } = await launchChatTab({ turns: {} }, { claude: { mcpServers: { github: GITHUB } } })
  try {
    // what Show in Explorer would open is recorded instead of opened
    await app.evaluate(({ shell }) => {
      const calls: string[] = []
      ;(globalThis as Record<string, unknown>).__openCalls = calls
      shell.openPath = (p: string) => { calls.push(p); return Promise.resolve('') }
    })
    await chatReady(page)
    await page.locator(TOGGLE).click()
    await page.locator(ROW('github')).getByRole('button', { name: 'More for github', exact: true }).click()
    await page.getByRole('button', { name: 'Open config file', exact: true }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__openCalls as string[])).toEqual([join(config, '.claude.json')])
  } finally {
    await app.close()
  }
})

test('the focus stays on the switch after it turns a server off', async () => {
  const { app, page } = await launchChatTab({ turns: {} }, { claude: { mcpServers: { github: GITHUB } } })
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    await page.getByRole('switch', { name: 'Turn github off' }).focus()
    await page.keyboard.press('Space')
    // the answer redraws the row in the OFF group: its switch, now labelled to turn on, has the focus
    await expect(page.getByRole('switch', { name: 'Turn github on' })).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('switch', { name: 'Turn github on' })).toBeFocused()
  } finally {
    await app.close()
  }
})

test('Sign in moves the focus to Cancel, and back to Sign in when the sign-in is cancelled', async () => {
  const { app, page } = await launchChatTab(
    { turns: {}, mcp: { sentry: { status: 'needs-auth' } }, ...LOGIN_GATE },
    { claude: { mcpServers: { sentry: SENTRY } } }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('sentry'))
    await row.getByRole('button', { name: 'Sign in', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(row).toContainText('Waiting for the browser…')
    await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await row.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toBeFocused()
  } finally {
    await app.close()
  }
})

test('Sign out logs the server out through Claude Code', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} }, { claude: { mcpServers: { github: GITHUB } } })
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    await page.locator(ROW('github')).getByRole('button', { name: 'More for github', exact: true }).click()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect.poll(() => cliCalls(log).some((c) => c.argv.includes('logout') && c.argv.includes('github'))).toBe(true)
  } finally {
    await app.close()
  }
})

test('Show tools lists the tools under the row, and Hide tools folds them again', async () => {
  const { app, page } = await launchChatTab({ turns: {}, mcp: { github: { tools: ['search', 'read'] } } }, { claude: { mcpServers: { github: GITHUB } } })
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('github'))
    await row.getByRole('button', { name: 'More for github', exact: true }).click()
    await page.getByRole('button', { name: 'Show tools', exact: true }).click()
    await expect(row.locator('.mcp-chip')).toHaveText(['search', 'read'])
    await row.getByRole('button', { name: 'More for github', exact: true }).click()
    await page.getByRole('button', { name: 'Hide tools', exact: true }).click()
    await expect(row.locator('.mcp-chip')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('Remove, then Cancel, keeps the server and runs no CLI call', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} }, { claude: { mcpServers: { github: GITHUB } } })
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('github'))
    await row.getByRole('button', { name: 'More for github', exact: true }).click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(row).toContainText('Remove github?')
    await row.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(row).not.toContainText('Remove github?')
    await expect(row.getByRole('button', { name: 'More for github', exact: true })).toBeEnabled()
    expect(cliCalls(log).some((c) => c.argv.includes('remove'))).toBe(false)
    await expect(row).toBeVisible()
  } finally {
    await app.close()
  }
})

test('while a sign-in runs the row\'s other buttons are off and Cancel stays on', async () => {
  const { app, page } = await launchChatTab(
    { turns: {}, mcp: { sentry: { status: 'needs-auth' } }, ...LOGIN_GATE },
    { claude: { mcpServers: { sentry: SENTRY } } }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('sentry'))
    await row.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(row).toContainText('Waiting for the browser…')
    await expect(row.getByRole('switch')).toBeDisabled()
    await expect(row.getByRole('button', { name: 'More for sentry', exact: true })).toBeDisabled()
    await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
    await row.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a sign-in still waits after the list is loaded again', async () => {
  const { app, page, config } = await launchChatTab(
    { turns: {}, mcp: { sentry: { status: 'needs-auth' } }, ...LOGIN_GATE },
    { claude: { mcpServers: { sentry: SENTRY } } }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('sentry'))
    await row.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(row).toContainText('Waiting for the browser…')
    // switching sections and back asks the servers again: the row keeps its wait
    await page.locator('.panel-mcp .mcp-seg-btn[data-section="plugins"]').click()
    await page.locator('.panel-mcp .mcp-seg-btn[data-section="servers"]').click()
    await expect(page.locator('.panel-mcp .mcp-seg-btn[data-section="servers"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(row).toContainText('Waiting for the browser…')
    writeFileSync(join(config, 'sentry-ok'), '')
    await expect(row.locator('.mcp-row')).toHaveAttribute('data-status', 'connected')
  } finally {
    await app.close()
  }
})
