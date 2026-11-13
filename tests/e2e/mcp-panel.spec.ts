import { expect, test } from '@playwright/test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAT_INPUT, chatReady, launchChatTab, userMessages } from './chat-helpers'

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
