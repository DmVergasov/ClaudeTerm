import { expect, test, type Page } from '@playwright/test'
import { chatReady, launchChatTab } from './chat-helpers'
import { chatStarts, cliCalls, runStandIn } from './mcp-helpers'

// The Plugins section of the MCP · Plugins panel: the installed plugins with their switches and updates, the Discover cards and their
// installs, the marketplaces, and the options a plugin with required settings asks for after its install. The stand-in Claude Code
// answers for the session and for the CLI; its marketplaces are the script's, added by the CLI calls below.

const TOGGLE = '.tab-mcp-toggle'
const PANEL = '.panel-mcp'
const PLUGINS_SEG = '.panel-mcp [data-section="plugins"]'
const SERVERS_SEG = '.panel-mcp [data-section="servers"]'
const CI_WATCH = 'ci-watch@acme-tools'
const DOCS_HELPER = 'docs-helper@acme-tools'
const KIT = 'code-review-kit@acme-tools'
const DEPLOY_GUARD = 'deploy-guard@acme-tools'

const ACME = [{
  name: 'acme-tools',
  source: 'acme/tools',
  plugins: [
    { name: 'ci-watch', description: 'Follows CI runs and explains what failed.', version: '1.0.0', installs: 812, options: [{ key: 'token', title: 'API token', required: true, sensitive: true }] },
    { name: 'docs-helper', description: 'Writes and checks the docs.', version: '0.4.0', installs: 150 },
    { name: 'code-review-kit', description: 'Reviews a diff with a checklist.', version: '1.3.0', installVersion: '1.2.0', installs: 2400 },
    { name: 'deploy-guard', description: 'Asks before a deploy goes out.', version: '2.0.0', installs: 90, options: [{ key: 'region', title: 'Region', description: 'Where the deploys go', required: true, sensitive: false }] }
  ]
}]

/** a CLI call of the stand-in Claude Code, made beside the running chat: it must succeed */
function standIn(config: string, work: string, args: string[]): void {
  expect(runStandIn(config, work, args).code).toBe(0)
}

/** the panel opens on the Plugins section */
async function openPlugins(page: Page): Promise<void> {
  await page.locator(TOGGLE).click()
  await page.locator(PLUGINS_SEG).click()
  await expect(page.locator(PLUGINS_SEG)).toHaveAttribute('aria-pressed', 'true')
}

/** one of the three sub-tabs of the section */
function subTab(page: Page, name: 'installed' | 'discover' | 'marketplaces'): ReturnType<Page['locator']> {
  return page.locator(`${PANEL} [data-sub="${name}"]`)
}

test('Installed lists the plugins with their switches and an update from the marketplace', async () => {
  const { app, page, config, work } = await launchChatTab({ turns: {}, marketplaces: ACME })
  try {
    await chatReady(page)
    standIn(config, work, ['plugin', 'marketplace', 'add', 'acme/tools'])
    standIn(config, work, ['plugin', 'install', '--', KIT])
    await openPlugins(page)
    await expect(subTab(page, 'installed')).toHaveAttribute('aria-pressed', 'true')
    const row = page.locator(`${PANEL} [data-name="${KIT}"]`)
    await expect(row).toContainText('1.3.0 available')
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    await row.locator('[data-focus-key="update"]').click()
    await expect(row).toContainText('acme-tools · 1.3.0')
    await expect(row).not.toContainText('available')
  } finally {
    await app.close()
  }
})

test('a GitHub link adds a marketplace and shows its plugins', async () => {
  const { app, page, log } = await launchChatTab({ turns: {}, marketplaces: ACME })
  try {
    await chatReady(page)
    await openPlugins(page)
    await subTab(page, 'marketplaces').click()
    await page.locator(`${PANEL} .mcp-market-add`).click()
    await page.locator(`${PANEL} .mcp-market-input`).fill('https://github.com/acme/tools')
    await page.locator(`${PANEL} [data-focus-key="market-add"]`).click()
    await expect(subTab(page, 'discover')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator(`${PANEL} .mcp-filter-chip`)).toHaveText('acme-tools ✕')
    await expect(page.locator(`${PANEL} .mcp-card`)).toHaveCount(4)
    await expect(page.locator(`${PANEL} [data-name="${CI_WATCH}"]`)).toContainText('acme-tools · 812')
    expect(cliCalls(log).find((c) => c.argv[1] === 'marketplace' && c.argv[2] === 'add')!.argv).toEqual(['plugin', 'marketplace', 'add', '--', 'acme/tools'])
  } finally {
    await app.close()
  }
})

test('Discover installs a plugin and the session restarts', async () => {
  const { app, page, log, config, work } = await launchChatTab({ turns: {}, marketplaces: ACME })
  try {
    await chatReady(page)
    standIn(config, work, ['plugin', 'marketplace', 'add', 'acme/tools'])
    await openPlugins(page)
    await subTab(page, 'discover').click()
    const card = page.locator(`${PANEL} [data-name="${DOCS_HELPER}"]`)
    await expect(card).toContainText('Writes and checks the docs.')
    await card.locator('[data-focus-key="install"]').click()
    await expect(page.locator(`${PANEL} [data-name="${DOCS_HELPER}"]`)).toHaveCount(0)
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(2)
    expect(cliCalls(log).find((c) => c.argv[1] === 'install')!.argv).toEqual(['plugin', 'install', '--scope', 'user', '--', DOCS_HELPER])
  } finally {
    await app.close()
  }
})

test('a plugin with a required option asks for it before the restart, and it goes through stdin', async () => {
  const { app, page, log, config, work } = await launchChatTab({ turns: {}, marketplaces: ACME })
  try {
    await chatReady(page)
    standIn(config, work, ['plugin', 'marketplace', 'add', 'acme/tools'])
    await openPlugins(page)
    await subTab(page, 'discover').click()
    await page.locator(`${PANEL} [data-name="${CI_WATCH}"] [data-focus-key="install"]`).click()
    const form = page.locator(`${PANEL} .mcp-options`)
    await expect(form).toContainText('ci-watch needs a few settings')
    await expect(form.getByLabel('API token')).toHaveAttribute('type', 'password')
    // the restart waits for the form: the chat is idle and settled, and still one start
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(chatStarts(log)).toBe(1)
    await form.getByLabel('API token').fill('tok-E2E-777')
    await form.locator('[data-focus-key="save"]').click()
    await expect(form).toHaveCount(0)
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(2)
    const last = cliCalls(log).find((c) => c.argv.includes('--values-stdin'))!
    expect(last.argv).toEqual(['plugin', 'configure', '--values-stdin', '--', CI_WATCH])
    expect(last.stdinKeys).toEqual(['token'])
    expect(last.argv.some((arg) => arg.includes('tok-E2E-777'))).toBe(false)
    expect(JSON.stringify(log())).not.toContain('tok-E2E-777')
    expect(await page.content()).not.toContain('tok-E2E-777')
  } finally {
    await app.close()
  }
})

test('a form that goes away without Save sends configure-later, so the session restarts', async () => {
  const { app, page, log, config, work } = await launchChatTab({ turns: {}, marketplaces: ACME })
  try {
    await chatReady(page)
    standIn(config, work, ['plugin', 'marketplace', 'add', 'acme/tools'])
    await openPlugins(page)
    await subTab(page, 'discover').click()
    await page.locator(`${PANEL} [data-name="${CI_WATCH}"] [data-focus-key="install"]`).click()
    await expect(page.locator(`${PANEL} .mcp-options`)).toBeVisible()
    // the section changes: the form goes away, and the chat restarts for the install
    await page.locator(SERVERS_SEG).click()
    await expect(page.locator(`${PANEL} .mcp-options`)).toHaveCount(0)
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(2)
    // Later: the same, from the form's own button
    await page.locator(PLUGINS_SEG).click()
    await subTab(page, 'discover').click()
    await page.locator(`${PANEL} [data-name="${DEPLOY_GUARD}"] [data-focus-key="install"]`).click()
    const form = page.locator(`${PANEL} .mcp-options`)
    await expect(form).toContainText('deploy-guard needs a few settings')
    await expect(form.getByLabel('Region')).toHaveAttribute('type', 'text')
    expect(chatStarts(log)).toBe(2)
    await form.locator('[data-focus-key="later"]').click()
    await expect(form).toHaveCount(0)
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(3)
  } finally {
    await app.close()
  }
})

test('turning a plugin off restarts the session', async () => {
  const { app, page, tabId, log, config, work } = await launchChatTab({ turns: {}, marketplaces: ACME })
  try {
    await chatReady(page)
    standIn(config, work, ['plugin', 'marketplace', 'add', 'acme/tools'])
    // the plugin is installed through the app, so its restart is the chat's own: the session starts again once
    await page.evaluate((id) => window.ct.mcpPluginAction(id, { kind: 'install', id: 'code-review-kit@acme-tools' }), tabId)
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(2)
    await openPlugins(page)
    const row = page.locator(`${PANEL} [data-name="${KIT}"]`)
    await row.getByRole('switch').click()
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(3)
    expect(cliCalls(log).find((c) => c.argv[1] === 'disable')!.argv).toEqual(['plugin', 'disable', '--', KIT])
  } finally {
    await app.close()
  }
})

test('Marketplaces updates and removes one', async () => {
  const { app, page, log, config, work } = await launchChatTab({ turns: {}, marketplaces: ACME })
  try {
    await chatReady(page)
    standIn(config, work, ['plugin', 'marketplace', 'add', 'acme/tools'])
    await openPlugins(page)
    await subTab(page, 'marketplaces').click()
    const row = page.locator(`${PANEL} [data-name="acme-tools"]`)
    await expect(row).toContainText('acme/tools')
    await row.locator('[data-focus-key="update"]').click()
    // main asks the list again after the update, so the update is found among the calls, not taken as the last one
    await expect.poll(() => cliCalls(log).find((c) => c.argv[1] === 'marketplace' && c.argv[2] === 'update')?.argv.join(' ') ?? '').toBe('plugin marketplace update -- acme-tools')
    await row.locator('[data-focus-key="remove"]').click()
    await expect(row).toContainText('Remove acme-tools?')
    await row.locator('[data-focus-key="confirm-remove"]').click()
    await expect(page.locator(`${PANEL} [data-name="acme-tools"]`)).toHaveCount(0)
    await expect(page.locator(`${PANEL} .mcp-list`)).toContainText('No marketplaces added')
    expect(cliCalls(log).find((c) => c.argv[1] === 'marketplace' && c.argv[2] === 'remove')!.argv).toEqual(['plugin', 'marketplace', 'remove', '--', 'acme-tools'])
  } finally {
    await app.close()
  }
})

test('a failed install shows its message on its card', async () => {
  const { app, page, log, config, work } = await launchChatTab({ turns: {}, marketplaces: ACME, cliFail: { 'plugin install': 'Plugin "x" not found in any marketplace' } })
  try {
    await chatReady(page)
    standIn(config, work, ['plugin', 'marketplace', 'add', 'acme/tools'])
    await openPlugins(page)
    await subTab(page, 'discover').click()
    const card = page.locator(`${PANEL} [data-name="${DOCS_HELPER}"]`)
    await card.locator('[data-focus-key="install"]').click()
    await expect(card.locator('.mcp-error')).toContainText('Plugin "x" not found in any marketplace')
    expect(chatStarts(log)).toBe(1)
  } finally {
    await app.close()
  }
})

test('a switch keeps the focus after Space, once the plugin is off', async () => {
  const { app, page, tabId, log, config, work } = await launchChatTab({ turns: {}, marketplaces: ACME })
  try {
    await chatReady(page)
    standIn(config, work, ['plugin', 'marketplace', 'add', 'acme/tools'])
    await page.evaluate((id) => window.ct.mcpPluginAction(id, { kind: 'install', id: 'code-review-kit@acme-tools' }), tabId)
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(2)
    await openPlugins(page)
    const sw = page.locator(`${PANEL} [data-name="${KIT}"]`).getByRole('switch')
    await sw.focus()
    await page.keyboard.press('Space')
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    // the answer is in and the list is drawn again: the switch that was used still has the focus
    await expect(sw).toBeFocused()
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(3)
  } finally {
    await app.close()
  }
})

test('after an install with a required option the first input of its form has the focus', async () => {
  const { app, page, config, work } = await launchChatTab({ turns: {}, marketplaces: ACME })
  try {
    await chatReady(page)
    standIn(config, work, ['plugin', 'marketplace', 'add', 'acme/tools'])
    await openPlugins(page)
    await subTab(page, 'discover').click()
    await page.locator(`${PANEL} [data-name="${CI_WATCH}"] [data-focus-key="install"]`).click()
    await expect(page.locator(`${PANEL} .mcp-options`)).toContainText('ci-watch needs a few settings')
    await expect(page.locator(`${PANEL} .mcp-options`).getByLabel('API token')).toBeFocused()
  } finally {
    await app.close()
  }
})
