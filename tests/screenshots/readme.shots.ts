// Generates the README screenshots in docs/images from demo data: `npm run screenshots`.
import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { assistantLine } from '../fixtures/transcript'
import { bufferText, launchApp } from '../e2e/helpers'

const OUT = resolve(__dirname, '..', '..', 'docs', 'images')
const DEMO_CLAUDE = resolve(__dirname, 'demo-claude.mjs')
const SID = '3b0d6c52-8f1e-4c9a-9d3e-6a2f1c7b5e40'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']
const REVENUE_2025 = [160, 168, 175, 171, 190, 198, 214, 220, 228]
const REVENUE_2026 = [182, 195, 210, 204, 228, 241, 276, 289, 301]

interface ChartSpec {
  title: string
  subtitle: string
  kind: 'bars' | 'lines'
  labels: string[]
  series: { name: string; color: string; values: number[] }[]
}

// Runs in the renderer (serialized by Playwright): must not reference anything outside itself.
function drawChart(s: ChartSpec): string {
  const W = 1600
  const H = 1000
  const L = 130
  const R = 70
  const T = 190
  const B = 110
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = '#16161a'
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#ececef'
  g.font = '600 54px "Segoe UI", sans-serif'
  g.fillText(s.title, L, 96)
  g.fillStyle = '#8a8a93'
  g.font = '32px "Segoe UI", sans-serif'
  g.fillText(s.subtitle, L, 146)
  let lx = W - R
  g.font = '30px "Segoe UI", sans-serif'
  for (const ser of [...s.series].reverse()) {
    const w = g.measureText(ser.name).width
    lx -= w
    g.fillStyle = '#b8b8c0'
    g.fillText(ser.name, lx, 100)
    lx -= 34
    g.fillStyle = ser.color
    g.beginPath()
    g.arc(lx + 12, 90, 11, 0, Math.PI * 2)
    g.fill()
    lx -= 36
  }
  const max = Math.max(...s.series.flatMap((x) => x.values)) * 1.15
  const pw = W - L - R
  const ph = H - T - B
  const y = (v: number): number => T + ph - (v / max) * ph
  g.lineWidth = 2
  g.font = '26px "Segoe UI", sans-serif'
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4
    g.strokeStyle = '#2a2a31'
    g.beginPath()
    g.moveTo(L, y(v))
    g.lineTo(W - R, y(v))
    g.stroke()
    g.fillStyle = '#6f6f78'
    g.textAlign = 'right'
    g.fillText(`$${Math.round(v)}k`, L - 18, y(v) + 9)
  }
  const step = pw / s.labels.length
  g.textAlign = 'center'
  g.fillStyle = '#8a8a93'
  s.labels.forEach((lab, i) => g.fillText(lab, L + step * (i + 0.5), H - B + 52))
  g.textAlign = 'left'
  if (s.kind === 'bars') {
    const bw = (step * 0.62) / s.series.length
    s.series.forEach((ser, j) =>
      ser.values.forEach((v, i) => {
        g.fillStyle = ser.color
        g.beginPath()
        g.roundRect(L + step * i + step * 0.19 + bw * j, y(v), bw - 8, T + ph - y(v), [12, 12, 0, 0])
        g.fill()
      })
    )
  } else {
    for (const ser of s.series) {
      const pts = ser.values.map((v, i) => [L + step * (i + 0.5), y(v)] as const)
      const fill = g.createLinearGradient(0, T, 0, T + ph)
      fill.addColorStop(0, `${ser.color}44`)
      fill.addColorStop(1, `${ser.color}00`)
      g.fillStyle = fill
      g.beginPath()
      g.moveTo(pts[0][0], T + ph)
      for (const [px, py] of pts) g.lineTo(px, py)
      g.lineTo(pts[pts.length - 1][0], T + ph)
      g.fill()
      g.strokeStyle = ser.color
      g.lineWidth = 7
      g.lineJoin = 'round'
      g.beginPath()
      pts.forEach(([px, py], i) => (i === 0 ? g.moveTo(px, py) : g.lineTo(px, py)))
      g.stroke()
      g.fillStyle = ser.color
      for (const [px, py] of pts) {
        g.beginPath()
        g.arc(px, py, 10, 0, Math.PI * 2)
        g.fill()
      }
    }
  }
  return c.toDataURL('image/png').slice('data:image/png;base64,'.length)
}

async function chart(page: Page, file: string, spec: ChartSpec): Promise<void> {
  writeFileSync(file, Buffer.from(await page.evaluate(drawChart, spec), 'base64'))
}

interface DemoSession { id: string; cwd: string; title: string; prompt: string; hoursAgo: number }

/** Invented conversations in a temporary Claude config folder: the Recent sessions shot must never show real history. */
function writeDemoSessions(config: string, sessions: DemoSession[]): void {
  for (const s of sessions) {
    const dir = join(config, 'projects', s.cwd.replace(/[^A-Za-z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${s.id}.jsonl`)
    const lines = [
      { type: 'user', cwd: s.cwd, entrypoint: 'cli', isSidechain: false, message: { role: 'user', content: s.prompt } },
      { type: 'ai-title', aiTitle: s.title },
      { type: 'last-prompt', lastPrompt: s.prompt }
    ]
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const at = new Date(Date.now() - s.hoursAgo * 3_600_000)
    utimesSync(file, at, at)
  }
}

test('README screenshots', async () => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'ct-shots-'))
  const project = join(root, 'acme-dashboard')
  const api = join(root, 'api-server')
  for (const dir of [project, api]) {
    mkdirSync(join(dir, 'out'), { recursive: true })
    copyFileSync(DEMO_CLAUDE, join(dir, 'demo-claude.mjs'))
  }

  // reports/ is not watched, so the show_image chart there arrives only through the pipe (with its caption)
  const settings = {
    claude: { command: 'node demo-claude.mjs', shellProfile: 'Windows PowerShell' },
    defaultProfile: 'Windows PowerShell',
    imageWatch: { ignore: ['.git', 'node_modules', 'reports'] }
  }
  const claudeConfig = join(root, 'claude-config')
  writeDemoSessions(claudeConfig, [
    { id: SID, cwd: project, title: 'Q3 revenue report with charts', prompt: 'Plot monthly revenue for 2026 and compare it with 2025', hoursAgo: 0.05 },
    { id: '8c1f4e2a-6b3d-4f5a-9e7c-2d1b0a3f4e5c', cwd: api, title: 'Rate limiting for the public API', prompt: 'add a per-key rate limit to /v1/orders', hoursAgo: 2 },
    { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', cwd: project, title: 'Flaky date filter test', prompt: 'the date filter test fails on Mondays, find out why', hoursAgo: 27 },
    { id: '7f6e5d4c-3b2a-4c1d-9e8f-7a6b5c4d3e2f', cwd: api, title: 'OAuth device flow for the CLI', prompt: 'switch the CLI login to the OAuth device flow', hoursAgo: 74 },
    { id: '2b4d6f8a-1c3e-4a5b-8d7f-9e0a1b2c3d4e', cwd: join(root, 'docs-site'), title: 'Getting started guide', prompt: 'write a getting started page for new contributors', hoursAgo: 122 },
    { id: '9d8c7b6a-5f4e-4d3c-a2b1-0f9e8d7c6b5a', cwd: join(root, 'mobile-app'), title: 'Crash when opening settings on Android 15', prompt: 'the app crashes on Android 15 when I open settings', hoursAgo: 480 }
  ])
  const { app, page, pipeName } = await launchApp({ settings, args: ['--claude', project], env: { CLAUDE_CONFIG_DIR: claudeConfig } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  // a 1280x800 window at 2x regardless of the monitor (a forced scale factor would not fit a 1080p screen)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false })
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio].join('x'))).toBe('1280x800x2')

  await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), api)
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd, title: 'PowerShell' }), root)
  await page.evaluate((id) => window.ct.activateTab(id), tabId)
  await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(tabId)
  await expect.poll(() => bufferText(page, tabId), { timeout: 20_000 }).toContain('North America leads Q3')

  // images: two files the "agent" saved in the project folder, one shown with show_image
  await page.waitForTimeout(1500) // let the folder watcher become ready
  await chart(page, join(project, 'out', 'revenue-2026.png'), {
    title: 'Revenue by month, 2026', subtitle: 'Net revenue, thousands of USD', kind: 'bars', labels: MONTHS,
    series: [{ name: '2026', color: '#d97757', values: REVENUE_2026 }]
  })
  await chart(page, join(project, 'out', 'revenue-yoy.png'), {
    title: 'Year over year', subtitle: 'Net revenue, thousands of USD', kind: 'lines', labels: MONTHS,
    series: [{ name: '2025', color: '#8a8a93', values: REVENUE_2025 }, { name: '2026', color: '#d97757', values: REVENUE_2026 }]
  })
  await expect.poll(() => page.evaluate(() => window.__ct!.images!().length), { timeout: 10_000 }).toBe(2)
  mkdirSync(join(project, 'reports'))
  const regions = join(project, 'reports', 'q3-regions.png')
  await chart(page, regions, {
    title: 'Q3 revenue by region', subtitle: 'Q3 2026, thousands of USD', kind: 'bars', labels: ['North America', 'EMEA', 'APAC', 'LATAM'],
    series: [{ name: 'Q3 2025', color: '#5b6b8c', values: [342, 288, 151, 80] }, { name: 'Q3 2026', color: '#6ea6e6', values: [401, 312, 188, 96] }]
  })
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: regions, caption: 'Q3 revenue by region' })).toEqual({ ok: true })
  await expect.poll(() => page.evaluate(() => window.__ct!.images!().length), { timeout: 10_000 }).toBe(3)

  // status bar: main session and three running subagents
  const projects = join(root, 'claude-projects', 'D--work-acme-dashboard')
  const subagents = join(projects, SID, 'subagents')
  mkdirSync(subagents, { recursive: true })
  const transcriptPath = join(projects, `${SID}.jsonl`)
  writeFileSync(transcriptPath, '')
  const agents: [string, string, string, string, string | undefined][] = [
    ['a1', 'Explore', 'Find other revenue reports', 'claude-sonnet-5-5', 'medium'],
    ['a2', 'code-reviewer', 'Review plot_revenue.py', 'claude-opus-5-5', 'high'],
    ['a3', 'general-purpose', 'Summarize the Q3 notes', 'claude-haiku-4-5-20251001', undefined]
  ]
  for (const [id, type, description, model, effort] of agents) {
    writeFileSync(join(subagents, `agent-${id}.jsonl`), assistantLine(model, effort) + '\n')
    writeFileSync(join(subagents, `agent-${id}.meta.json`), JSON.stringify({ agentType: type, description }))
  }
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  expect(
    await sendPipeMessage(pipeName, {
      v: 1, type: 'status', tabId, sessionId: SID,
      model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'high',
      context: { usedTokens: 76_412, size: 200_000, usedPct: 38.2 },
      fiveHour: { usedPct: 23.4, resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 },
      sevenDay: { usedPct: 41.2, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 }
    })
  ).toEqual({ ok: true })
  for (const [id, type] of agents) {
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'subagent', tabId, sessionId: SID, event: 'start', agentId: id, agentType: type })).toEqual({ ok: true })
  }
  const bar = page.locator('#statusbar')
  await expect(bar.locator('.status-agents')).toHaveText('⚙ 3: sonnet·medium, opus·high, haiku', { timeout: 10_000 })

  await page.mouse.move(400, 400)
  await page.screenshot({ path: join(OUT, 'hero.png') })

  const barBox = (await bar.boundingBox())!
  const agentsBox = (await bar.locator('.status-agents').boundingBox())!
  await page.screenshot({ path: join(OUT, 'status-bar.png'), clip: { x: 0, y: barBox.y, width: Math.ceil(agentsBox.x + agentsBox.width + 16), height: barBox.height } })

  await page.locator('.card img').nth(1).click()
  await expect(page.locator('#lightbox')).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, 'lightbox.png') })
  await page.keyboard.press('Escape')
  await expect(page.locator('#lightbox')).toBeHidden()

  await page.locator('.tab-menu').click()
  const menu = page.locator('.menu')
  await expect(menu).toBeVisible()
  const menuBox = (await menu.boundingBox())!
  await page.screenshot({ path: join(OUT, 'new-tab-menu.png'), clip: { x: 0, y: 0, width: Math.ceil(menuBox.x + menuBox.width + 24), height: Math.ceil(menuBox.y + menuBox.height + 24) } })

  await page.locator('.menu-item', { hasText: 'Recent sessions…' }).click()
  const sessionsBox = page.locator('#sessions .sessions-box')
  await expect(sessionsBox.locator('.session-row')).toHaveCount(6)
  await page.mouse.move(1270, 790)
  const box = (await sessionsBox.boundingBox())!
  await page.screenshot({ path: join(OUT, 'recent-sessions.png'), clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } })
  await page.keyboard.press('Escape')

  await app.close()
})

test('settings window screenshot', async () => {
  // default settings in a fresh data folder: nothing from this machine's own settings
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const [win] = await Promise.all([app.waitForEvent('window'), page.evaluate(() => window.ct.openSettingsWindow())])
  await win.waitForSelector('#settings [data-key="font.size"]')
  const cdp = await win.context().newCDPSession(win)
  await expect(win.locator('[data-key="font.family"]')).toHaveValue('Cascadia Mono, Consolas, monospace')
  // the whole form, without the scrollbar a 720 px tall window has
  const height = await win.evaluate(() => document.documentElement.scrollHeight)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height, deviceScaleFactor: 2, mobile: false })
  await expect.poll(() => win.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true)
  await win.mouse.move(630, 10)
  await win.screenshot({ path: join(OUT, 'settings.png') })
  await app.close()
})
