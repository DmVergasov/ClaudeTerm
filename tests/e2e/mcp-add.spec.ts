import { expect, test, type Page } from '@playwright/test'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatItem } from '../../src/shared/chat'
import { chatReady, launchChatTab } from './chat-helpers'
import { cliCalls, readJsonFile } from './mcp-helpers'

// The "Add an MCP server" dialog of the MCP · Plugins panel: a pasted command, URL or JSON config is recognised, its secrets are
// masked and never shown once recognised, its names can be edited, and it is added through Claude Code's CLI in the scope asked.
// The stand-in Claude Code answers for the session and the CLI; its configuration folder holds the servers.

type DividerItem = Extract<ChatItem, { kind: 'divider' }>

const TOGGLE = '.tab-mcp-toggle'
const ADD_BUTTON = '.panel-mcp .mcp-footer .mcp-btn.primary'
const DIALOG = '.mcp-add'
const FIELD = '.mcp-add-field'
const CONTEXT7_COMMAND = 'claude mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: sk-test-123"'
const ACME_TOOLS = [{
  name: 'acme-tools',
  source: 'acme/tools',
  plugins: [{ name: 'ci-watch', description: 'Follows CI runs and explains what failed.', version: '1.0.0', installs: 812, options: [{ key: 'token', title: 'API token', required: true, sensitive: true }] }]
}]

async function dividers(page: Page, tabId: string): Promise<string[]> {
  const items = (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.items ?? []
  return items.filter((item): item is DividerItem => item.kind === 'divider').map((item) => item.text)
}

/** the panel is open on the chat in front, and its dialog is opened by the footer's Add server button */
async function openDialog(page: Page): Promise<void> {
  await chatReady(page)
  await page.locator(TOGGLE).click()
  await expect(page.locator('.panel-mcp')).toBeVisible()
  await page.locator(ADD_BUTTON).click()
  await expect(page.locator(DIALOG)).toBeVisible()
  await expect(page.locator(FIELD)).toBeFocused()
}

/** a text pasted into the dialog's field: a paste event with the text, as the system clipboard would deliver it */
async function paste(page: Page, text: string): Promise<void> {
  await page.locator(FIELD).evaluate((field, pasted) => {
    const data = new DataTransfer()
    data.setData('text/plain', pasted)
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
}

/** the rows the dialog shows for a server: each row's label and value, as one line */
async function previewRows(page: Page): Promise<string[]> {
  return page.locator('.mcp-add-row').evaluateAll((rows) => rows.map((row) => [...row.children].map((c) => c.textContent).join(' ')))
}

test('a pasted command is recognised with its header masked, and added for all projects', async () => {
  const { app, page, tabId, config } = await launchChatTab({ turns: {}, mcp: { context7: { tools: ['resolve-library-id', 'get-library-docs'] } } })
  try {
    await openDialog(page)
    await paste(page, CONTEXT7_COMMAND)
    await expect(page.locator('.mcp-add-found')).toContainText('✓ Recognized')
    await expect.poll(() => previewRows(page)).toEqual(['Type HTTP', 'Address https://mcp.context7.com/mcp', 'Header CONTEXT7_API_KEY: ••••••••'])
    await expect(page.locator('.mcp-add-masked-text')).toHaveText('claude mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: ••••••••"')
    await expect(page.locator('.mcp-add-field')).toBeHidden()
    await expect(page.getByRole('radio', { name: /All my projects/ })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: 'Add and restart' }).click()
    await expect(page.locator(DIALOG)).toBeHidden()
    expect(readJsonFile(join(config, '.claude.json')).mcpServers.context7.headers.CONTEXT7_API_KEY).toBe('sk-test-123')
    await expect.poll(() => dividers(page, tabId), { timeout: 30_000 }).toContain('Session restarted · context7 connected · 2 tools')
  } finally {
    await app.close()
  }
})

test('the key never shows once recognised, nor in the log', async () => {
  const { app, page, dataDir } = await launchChatTab({ turns: {} })
  try {
    await openDialog(page)
    await paste(page, CONTEXT7_COMMAND)
    await expect(page.locator('.mcp-add-masked-text')).toBeVisible()
    const shown = await page.evaluate(() => ({
      values: [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('textarea, input')].map((field) => field.value),
      text: document.body.innerText
    }))
    expect(shown.values.join('\n')).not.toContain('sk-test-123')
    expect(shown.text).not.toContain('sk-test-123')
    await page.getByRole('button', { name: 'Add and restart' }).click()
    await expect(page.locator(DIALOG)).toBeHidden()
    const logs = readdirSync(dataDir, { recursive: true }).map(String).filter((file) => file.endsWith('.log') && statSync(join(dataDir, file)).isFile())
    expect(logs.length).toBeGreaterThan(0)
    for (const file of logs) expect(readFileSync(join(dataDir, file), 'utf8')).not.toContain('sk-test-123')
  } finally {
    await app.close()
  }
})

test('a JSON with two servers adds both to .mcp.json', async () => {
  const { app, page, work } = await launchChatTab({ turns: {} })
  try {
    await openDialog(page)
    await paste(page, JSON.stringify({
      mcpServers: {
        docs: { type: 'http', url: 'https://example.com/docs' },
        search: { type: 'http', url: 'https://example.com/search' }
      }
    }))
    await expect(page.getByRole('button', { name: 'Add 2 servers and restart' })).toBeEnabled()
    await page.getByRole('radio', { name: /This project, shared/ }).click()
    await page.getByRole('button', { name: 'Add 2 servers and restart' }).click()
    await expect(page.locator(DIALOG)).toBeHidden()
    const servers = readJsonFile(join(work, '.mcp.json')).mcpServers
    expect(Object.keys(servers).sort()).toEqual(['docs', 'search'])
    expect(servers.search).toEqual({ type: 'http', url: 'https://example.com/search', headers: {} })
  } finally {
    await app.close()
  }
})

test('the name can be edited and the server added for this project only', async () => {
  const { app, page, work, config } = await launchChatTab({ turns: {} })
  try {
    await openDialog(page)
    await paste(page, 'claude mcp add --transport http docs https://example.com/docs')
    const name = page.getByLabel('Name', { exact: true })
    await expect(name).toHaveValue('docs')
    await name.fill('docs-search')
    await page.getByRole('radio', { name: /This project, only me/ }).click()
    await page.getByRole('button', { name: 'Add and restart' }).click()
    await expect(page.locator(DIALOG)).toBeHidden()
    const projects = readJsonFile(join(config, '.claude.json')).projects
    expect(projects[realpathSync.native(work)].mcpServers['docs-search']).toEqual({ type: 'http', url: 'https://example.com/docs', headers: {} })
  } finally {
    await app.close()
  }
})

test('text that is not a server says why and Add stays disabled', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await openDialog(page)
    await paste(page, 'claude mcp list')
    await expect(page.locator('.mcp-add-reason')).toHaveText('Not a claude mcp add command, a URL or a JSON config')
    await expect(page.getByRole('button', { name: 'Add and restart' })).toBeDisabled()
  } finally {
    await app.close()
  }
})

test('a GitHub link offers to add a plugin marketplace', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: {}, marketplaces: ACME_TOOLS })
  try {
    await openDialog(page)
    await paste(page, 'https://github.com/acme/tools')
    await expect(page.locator('.mcp-add-found')).toContainText('This is a GitHub repository: acme/tools')
    await page.getByRole('button', { name: 'Add as a plugin marketplace' }).click()
    await expect(page.locator(DIALOG)).toBeHidden()
    await expect(page.locator('.panel-mcp [data-section="plugins"]')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await page.evaluate((id) => window.ct.mcpPlugins(id), tabId)) ?? null).toMatchObject({
      marketplaces: [{ name: 'acme-tools', source: 'acme/tools' }]
    })
  } finally {
    await app.close()
  }
})

test('a client secret is asked for and goes to Claude Code in its environment', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await openDialog(page)
    await paste(page, 'claude mcp add --transport http sentry https://mcp.example.com/sentry --client-id client-abc --client-secret')
    const secret = page.getByLabel('OAuth client secret')
    await expect(secret).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add and restart' })).toBeDisabled()
    await secret.fill('cs-123')
    await page.getByRole('button', { name: 'Add and restart' }).click()
    await expect(page.locator(DIALOG)).toBeHidden()
    const last = cliCalls(log).at(-1)!
    expect(last.secretEnv).toBe(true)
    expect(last.argv).toContain('--client-secret')
    expect(last.argv.some((arg) => arg.includes('cs-123'))).toBe(false)
  } finally {
    await app.close()
  }
})
