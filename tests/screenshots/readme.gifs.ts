// Records the animated README demos in docs/images from demo data: `npm run gifs` (needs ffmpeg on the PATH).
// The app runs Claude tabs in their chat on the stand-in Claude Code (tests/fixtures/fake-claude), which plays an invented
// conversation; a CDP screencast takes the frames, a band under them carries a caption, and ffmpeg makes the GIF.
// GIF_OUT_DIR writes the GIFs elsewhere than docs/images, GIF_FRAMES_DIR keeps the frames there to look at.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { FakeScript, FakeStep } from '../fixtures/fake-claude/install'
import { chatReady } from '../e2e/chat-helpers'
import { launchApp, makeDataDir, openTabInFront } from '../e2e/helpers'
import { chart, MONTHS, REVENUE_2025, REVENUE_2026 } from './charts'

const OUT = process.env.GIF_OUT_DIR ?? resolve(__dirname, '..', '..', 'docs', 'images')
const STAND_IN = resolve(__dirname, '..', 'fixtures', 'fake-claude', 'fake-claude.ts')
const WIDTH = 1280
const HEIGHT = 800
/** the caption band under the window */
const BAND = 44
const FPS = 15

/** the stand-in Claude Code as a command in the folder */
function installCommand(dir: string): string {
  mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    const file = join(dir, 'claude.cmd')
    writeFileSync(file, `@"${process.execPath}" --experimental-strip-types --no-warnings "${STAND_IN}" %*\r\n`)
    return file
  }
  const file = join(dir, 'claude')
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types --no-warnings "${STAND_IN}" "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

/** an invented git repository with one commit of the files */
function repo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'demo@example.com')
  git(dir, 'config', 'user.name', 'Demo')
  git(dir, 'config', 'core.autocrlf', 'false')
  writeFiles(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'initial')
  return dir
}

const QUIET_CASE = { sound: false, flash: false, tab: true, front: false, banner: false }

interface Demo { app: ElectronApplication; page: Page; pipeName: string; config: string }

/**
 * The app with Claude tabs in their chat on the stand-in, which plays the script; every folder in `trusted` is trusted.
 * The tabs are on the left. Nothing rings, flashes or pops a notification on the machine the demo is recorded on.
 */
async function launchDemo(script: FakeScript, first: string, trusted: string[], more: object = {}, tabPanelWidth = 240): Promise<Demo> {
  const root = mkdtempSync(join(tmpdir(), 'ct-gif-'))
  const config = join(root, 'config')
  mkdirSync(config, { recursive: true })
  const command = installCommand(join(root, 'bin'))
  const scriptFile = join(root, 'script.json')
  writeFileSync(scriptFile, JSON.stringify(script))
  const projects = Object.fromEntries(trusted.map((dir) => [realpathSync.native(dir), { hasTrustDialogAccepted: true }]))
  writeFileSync(join(config, '.claude.json'), JSON.stringify({ projects }))
  const settings = {
    claude: { command, shellProfile: 'Windows PowerShell', view: 'chat', autoContinue: false, headsUp: false },
    defaultProfile: 'Windows PowerShell',
    tabs: { position: 'left' },
    sidePanel: { noRoom: 'narrow' },
    notifications: { sound: 'system', permission: QUIET_CASE, question: QUIET_CASE, done: QUIET_CASE, bell: QUIET_CASE },
    ...more
  }
  const dataDir = makeDataDir(settings)
  writeFileSync(join(dataDir, 'tab-layout.json'), JSON.stringify({ width: tabPanelWidth, folded: [] }))
  const { app, page, pipeName } = await launchApp({
    dataDir,
    args: ['--claude', first],
    env: { CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_SCRIPT: scriptFile, FAKE_CLAUDE_LOG: join(root, 'fake-claude.log'), CLAUDETERM_TEST_SOUND_LOG: join(root, 'sounds.log') }
  })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  return { app, page, pipeName, config }
}

/** the window at the GIF's size, on the primary screen */
async function frameWindow({ app, page }: Demo): Promise<void> {
  await app.evaluate(({ BrowserWindow, screen }, size) => {
    const w = BrowserWindow.getAllWindows()[0]!
    const area = screen.getPrimaryDisplay().workArea
    w.setPosition(area.x, area.y)
    w.setContentSize(size.width, size.height)
    // a side panel would widen the window, and the frames would shrink to fit: the panel takes its room from the chat instead
    const b = w.getBounds()
    w.setMaximumSize(b.width, b.height)
  }, { width: WIDTH, height: HEIGHT })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight].join('x'))).toBe(`${WIDTH}x${HEIGHT}`)
}

/** a pointer the viewer can follow and a ring where it clicks: drawn in the page, for the GIF only */
async function installPointer(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = `
      #gif-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; transform: translate(-50px, -50px); filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)) }
      #gif-ring { position: fixed; left: 0; top: 0; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%; border: 2px solid #d97757; z-index: 2147483646; pointer-events: none; opacity: 0 }
      #gif-ring.on { animation: gif-ring .5s ease-out }
      @keyframes gif-ring { from { opacity: 1; transform: scale(.3) } to { opacity: 0; transform: scale(1.3) } }
    `
    document.head.appendChild(style)
    const cursor = document.createElement('div')
    cursor.id = 'gif-cursor'
    cursor.innerHTML = '<svg width="18" height="24" viewBox="0 0 18 24"><path d="M1 1 L1 19 L5.5 14.8 L8.6 22 L11.6 20.7 L8.6 13.6 L14.6 13.6 Z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>'
    const ring = document.createElement('div')
    ring.id = 'gif-ring'
    document.body.append(ring, cursor)
    document.addEventListener('mousemove', (e) => { cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)` }, true)
    document.addEventListener('mousedown', (e) => {
      ring.style.left = `${e.clientX}px`
      ring.style.top = `${e.clientY}px`
      ring.classList.remove('on')
      void ring.offsetWidth
      ring.classList.add('on')
    }, true)
  })
  await page.mouse.move(at.x, at.y)
  pointer = at
}

/** where the pointer is now */
let pointer = { x: WIDTH / 2, y: HEIGHT / 2 }

/** the pointer glides to the element's middle (or a point in it) at a pace a viewer can follow */
async function glide(page: Page, selector: string, at?: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const box = (await page.locator(selector).first().boundingBox())!
  const to = { x: Math.round(box.x + (at ? at.x : box.width / 2)), y: Math.round(box.y + (at ? at.y : box.height / 2)) }
  const steps = Math.max(10, Math.round(Math.hypot(to.x - pointer.x, to.y - pointer.y) / 16))
  await page.mouse.move(to.x, to.y, { steps })
  pointer = to
  return to
}

async function glideAndClick(page: Page, selector: string, at?: { x: number; y: number }): Promise<void> {
  const to = await glide(page, selector, at)
  await page.waitForTimeout(200)
  await page.mouse.click(to.x, to.y)
}

async function glideTo(page: Page, x: number, y: number): Promise<void> {
  const steps = Math.max(10, Math.round(Math.hypot(x - pointer.x, y - pointer.y) / 16))
  await page.mouse.move(x, y, { steps })
  pointer = { x, y }
}

interface Frame { file: string; t: number }

/** a CDP screencast of the page, every frame with its time, and the captions with the times they came */
class Recording {
  private readonly frames: Frame[] = []
  private readonly captions: { text: string; t: number }[] = []

  private constructor(private readonly page: Page, private readonly dir: string, private readonly cdp: Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>) {}

  static async start(page: Page, dir: string): Promise<Recording> {
    mkdirSync(dir, { recursive: true })
    const rec = new Recording(page, dir, await page.context().newCDPSession(page))
    rec.cdp.on('Page.screencastFrame', (f) => {
      const file = join(dir, `${String(rec.frames.length).padStart(5, '0')}.png`)
      writeFileSync(file, Buffer.from(f.data, 'base64'))
      rec.frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 })
      rec.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    })
    await rec.cdp.send('Page.startScreencast', { format: 'png', maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 2 })
    return rec
  }

  /** the caption from now on ('' for none) */
  caption(text: string): void {
    this.captions.push({ text, t: Date.now() / 1000 })
  }

  /** stops, and writes the GIF: each of its ticks shows the last frame drawn by then, over the caption of that moment */
  async finish(out: string): Promise<void> {
    const end = Date.now() / 1000
    await this.cdp.send('Page.stopScreencast')
    const frames = this.frames
    expect(frames.length).toBeGreaterThan(0)
    const start = frames[0]!.t
    const lines: string[] = []
    let i = 0
    for (let k = 0; k <= Math.floor((end - start) * FPS); k++) {
      while (i + 1 < frames.length && frames[i + 1]!.t - start <= k / FPS) i++
      lines.push(`file '${frames[i]!.file.replace(/\\/g, '/')}'`, `duration ${(1 / FPS).toFixed(6)}`)
    }
    // the concat demuxer keeps the last entry's duration only when the entry is given once more
    lines.push(lines[lines.length - 2]!)
    const list = join(this.dir, 'frames.txt')
    writeFileSync(list, lines.join('\n') + '\n')

    const inputs = ['-f', 'concat', '-safe', '0', '-i', list]
    const graph = [`[0:v]fps=${FPS},pad=${WIDTH}:${HEIGHT + BAND}:0:0:color=0x0A0A0C[v0]`]
    let last = 'v0'
    for (const [n, c] of this.captions.entries()) {
      if (!c.text) continue
      const file = join(this.dir, `caption-${n}.png`)
      await captionImage(this.page, c.text, file)
      inputs.push('-i', file)
      const from = Math.max(0, c.t - start)
      const to = (this.captions[n + 1]?.t ?? end) - start
      graph.push(`[${last}][${inputs.filter((x) => x === '-i').length - 1}:v]overlay=0:${HEIGHT}:enable='between(t,${from.toFixed(3)},${to.toFixed(3)})'[v${n + 1}]`)
      last = `v${n + 1}`
    }
    graph.push(`[${last}]split[a][b]`, '[a]palettegen=max_colors=256:stats_mode=diff[p]', '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle')
    mkdirSync(join(out, '..'), { recursive: true })
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', graph.join(';'), '-loop', '0', out], { stdio: 'inherit' })
  }
}

/** the caption band as a picture, in the app's own font and colours */
async function captionImage(page: Page, text: string, file: string): Promise<void> {
  const data = await page.evaluate(async (o) => {
    await document.fonts.load('600 15px "Inter Variable"')
    const c = document.createElement('canvas')
    c.width = o.width
    c.height = o.height
    const g = c.getContext('2d')!
    g.fillStyle = '#0A0A0C'
    g.fillRect(0, 0, o.width, o.height)
    g.fillStyle = '#1C1C21'
    g.fillRect(0, 0, o.width, 1)
    g.font = '600 15px "Inter Variable", "Segoe UI", sans-serif'
    g.textBaseline = 'middle'
    const x = (o.width - g.measureText(o.text).width) / 2 + 9
    g.fillStyle = '#D97757'
    g.beginPath()
    g.arc(x - 14, o.height / 2 + 0.5, 4, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = '#EDEDF0'
    g.fillText(o.text, x, o.height / 2 + 1)
    return c.toDataURL('image/png').slice('data:image/png;base64,'.length)
  }, { text, width: WIDTH, height: BAND })
  writeFileSync(file, Buffer.from(data, 'base64'))
}

/** the frames of a recording: in GIF_FRAMES_DIR when set (to look at them), else in the run's temp folder */
function framesDir(root: string, name: string): string {
  return process.env.GIF_FRAMES_DIR ? join(process.env.GIF_FRAMES_DIR, name) : join(root, `frames-${name}`)
}

/** the tool calls of the tab's chat by that name (only those that have ended, with done) */
function calls(page: Page, tabId: string, name: string, done = false): Promise<number> {
  return page.evaluate(async (o) => {
    const s = await window.ct.chatSnapshot(o.tabId)
    return (s?.items ?? []).flatMap((item) => item.kind === 'tools' ? item.calls : []).filter((c) => c.name === o.name && (!o.done || c.state !== 'running')).length
  }, { tabId, name, done })
}

/** the tab's chat has that many tool calls by the name (that many ended, with done) */
async function waitCall(page: Page, tabId: string, name: string, done = false, count = 1): Promise<void> {
  await expect.poll(() => calls(page, tabId, name, done), { timeout: 30_000 }).toBeGreaterThanOrEqual(count)
}

/** the tab's turn has ended */
async function waitIdle(page: Page, tabId: string): Promise<void> {
  await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
}

/** the session id of the tab's chat, once Claude Code has named it */
async function sessionOf(page: Page, tabId: string): Promise<string> {
  let id: string | null = null
  await expect.poll(async () => (id = (await page.evaluate((t) => window.ct.chatSnapshot(t), tabId))?.state.sessionId ?? null), { timeout: 15_000 }).not.toBeNull()
  return id!
}

/**
 * What Claude Code's hooks tell ClaudeTerm, which the stand-in does not run: the session started, Claude waits for the
 * person, or the turn is over
 */
async function hook(demo: Demo, tabId: string, what: 'session' | 'permission' | 'done'): Promise<void> {
  const sessionId = await sessionOf(demo.page, tabId)
  const message = what === 'session'
    ? { v: 1 as const, type: 'session' as const, tabId, sessionId, source: 'startup', transcriptPath: null }
    : { v: 1 as const, type: 'attention' as const, tabId, sessionId, reason: what }
  expect(await sendPipeMessage(demo.pipeName, message)).toEqual({ ok: true })
}

/**
 * The Changes panel reads the files again, as an edit in Claude Code's transcript would have it do: the stand-in's
 * transcript carries no edits. It is the refresh the panel's ⟳ asks for
 */
async function refreshChanges(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.ct.refreshReview(id), tabId)
}

/** the name of the left panel's group each tab is in, by tab id (a tab not in the panel is left out) */
function groupsOf(page: Page, ids: string[]): Promise<Record<string, string>> {
  return page.evaluate((list) => Object.fromEntries(list.flatMap((id) => {
    const row = document.querySelector(`#tabpanel .tp-tab[data-tab-id="${id}"]`)
    return row ? [[id, row.closest('.tp-group')?.querySelector('.tp-group-name')?.textContent?.toLowerCase() ?? '']] : []
  })), ids)
}

/**
 * Each tab sits in its project's group, and stays there while the demo is recorded: a git call that a busy machine does
 * not answer in time lists a tab under No project for a while. The page notes every time one is out of place;
 * `groupsKept` fails the recording then, rather than write a GIF that shows it
 */
async function keepGroups(page: Page, want: Record<string, string>): Promise<void> {
  await expect.poll(() => groupsOf(page, Object.keys(want)), { timeout: 30_000 }).toEqual(want)
  await page.evaluate((w) => {
    const misplaced: string[] = []
    const check = (): void => {
      for (const [id, name] of Object.entries(w)) {
        const row = document.querySelector(`#tabpanel .tp-tab[data-tab-id="${id}"]`)
        const group = row?.closest('.tp-group')?.querySelector('.tp-group-name')?.textContent?.toLowerCase()
        if (row && group !== name) misplaced.push(`${name} tab under ${group}`)
      }
    }
    new MutationObserver(check).observe(document.getElementById('tabpanel')!, { subtree: true, childList: true, characterData: true })
    ;(window as unknown as { gifMisplaced: string[] }).gifMisplaced = misplaced
  }, want)
}

async function groupsKept(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { gifMisplaced: string[] }).gifMisplaced)).toEqual([])
}

/** the stand-in's turn waiting on <config>/<gate> goes on */
function release(demo: Demo, gate: string): void {
  writeFileSync(join(demo.config, gate), '')
}

async function typeMessage(page: Page, text: string, glideThere = true): Promise<void> {
  await chatReady(page)
  if (glideThere) await glideAndClick(page, '.chat-host:visible .chat-input')
  else await page.locator('.chat-host:visible .chat-input').click()
  await page.keyboard.type(text, { delay: 26 })
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
}

const hours = (n: number): number => Math.floor(Date.now() / 1000) + n * 3600
const LIMITS: FakeStep = {
  rateLimit: {
    type: 'five_hour', utilization: 0.34, resetsAt: hours(2.3),
    windows: { five_hour: { utilization: 0.34, resetsAt: hours(2.3) }, seven_day: { utilization: 0.46, resetsAt: hours(70) } }
  }
}
const CONTEXT = { model: 'claude-opus-5-5', effort: 'high', contextPct: 38, contextTokens: 76_412, contextMax: 200_000 }

const SALES_PROMPT = 'What does the sales export hold?'
const CHART_PROMPT = 'Plot monthly revenue for 2026 and compare it with 2025'
/** the first lines of the invented sales export, as Read returns them */
const SALES_LINES = ['date,region,product,net_total', '2026-01-02,EMEA,Pro plan,1840.00', '2026-01-02,North America,Team plan,4120.00',
  '2026-01-03,APAC,Pro plan,960.00', '2026-01-03,North America,Pro plan,1520.00', '2026-01-04,LATAM,Team plan,2310.00']
  .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n')
const API_PROMPT = 'Add a per-key rate limit to /v1/orders'
const REGIONS_PROMPT = 'Draw the Q3 revenue by region'
const REGION_QUESTION = {
  questions: [{
    question: 'How should the Q3 regions be shown?',
    header: 'Chart',
    multiSelect: false,
    options: [
      { label: 'Bars per region (Recommended)', description: 'One bar per region, 2025 next to 2026' },
      { label: 'Stacked bars', description: 'The regions add up to one bar per quarter' }
    ]
  }]
}

test('overview', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-gif-work-'))
  const acme = repo(join(root, 'acme-dashboard'), {
    '.gitignore': 'reports/\n',
    'src/charts/revenue.ts': 'export function revenueByMonth(year: number): number[] {\n  return []\n}\n',
    'data/sales-2026.csv': 'month,total\n',
    'README.md': '# Acme dashboard\n'
  })
  const regions = join(root, 'acme-q3-regions')
  git(acme, 'worktree', 'add', '-q', '-b', 'feat/q3-regions', regions)
  const api = repo(join(root, 'api-server'), { 'src/routes/orders.ts': 'export {}\n' })
  const scratch = join(root, 'scratch')
  const reports = join(acme, 'reports')
  mkdirSync(scratch)
  mkdirSync(reports)

  const script: FakeScript = {
    ...CONTEXT,
    turns: {
      [SALES_PROMPT]: [
        LIMITS,
        { tool: { name: 'Read', input: { file_path: 'data/sales-2026.csv', limit: 6 }, result: SALES_LINES, ms: 300 } },
        { text: 'One row per order, January to September 2026: the date, the region, the plan and the net total in dollars.' }
      ],
      [CHART_PROMPT]: [
        LIMITS,
        { text: "I'll read the whole export, plot both charts and have three agents check the numbers.", rate: 30 },
        { tool: { name: 'Read', input: { file_path: 'data/sales-2026.csv' }, result: SALES_LINES, ms: 700 } },
        { tool: { name: 'Bash', input: { command: 'python scripts/plot_revenue.py --year 2026 --compare 2025 --out reports', description: 'Plot the revenue charts' }, result: 'Saved reports/revenue-2026.png and reports/revenue-yoy.png', ms: 1500 } },
        {
          task: {
            description: 'Check the numbers',
            result: 'The totals match the ledger; two older reports found.',
            agents: [
              { type: 'Explore', description: 'Find other revenue reports', ms: 5600, model: 'sonnet', effort: 'medium', work: { model: 'claude-sonnet-5-5', context: 18_400 } },
              { type: 'code-reviewer', description: 'Review plot_revenue.py', ms: 7200, model: 'opus', effort: 'high', work: { model: 'claude-opus-5-5', context: 31_200 } },
              { type: 'general-purpose', description: 'Check the 2025 totals', ms: 4400, model: 'haiku', work: { model: 'claude-haiku-5-5', context: 9_100 } }
            ]
          }
        },
        { text: 'Revenue is up in every month of 2026: **+18 %** year over year, strongest in July–September. Both charts are in the Media panel.', rate: 40 },
        {
          ask: { tool: 'AskUserQuestion', input: REGION_QUESTION },
          allowed: [
            { text: 'Bars per region it is.', rate: 30 },
            { tool: { name: 'Write', input: { file_path: 'src/charts/regions.ts', content: 'export {}\n' }, result: 'File created', ms: 900 } },
            { text: 'Done: `regions.ts` draws Q3 by region, 2025 next to 2026.', rate: 30 }
          ],
          denied: []
        }
      ],
      [API_PROMPT]: [
        LIMITS,
        { text: "I'll put a token bucket per API key in front of the orders routes.", rate: 20 },
        { tool: { name: 'Read', input: { file_path: 'src/routes/orders.ts' }, result: 'Read 86 lines', ms: 900 } },
        { tool: { name: 'Write', input: { file_path: 'src/middleware/rate-limit.ts', content: 'export {}\n' }, result: 'File created', ms: 1200 } },
        { gate: 'api-ask' },
        {
          ask: { tool: 'Bash', input: { command: 'npm test -- rate-limit', description: 'Run the rate limit tests' } },
          allowed: [
            { tool: { name: 'Bash', input: { command: 'npm test -- rate-limit', description: 'Run the rate limit tests' }, result: 'Tests: 12 passed, 12 total', ms: 1400 } },
            { text: 'Done: every API key gets **100 requests a minute** on `/v1/orders`, and the tests pass.', rate: 30 }
          ],
          denied: [{ text: 'OK, I will not run them.' }]
        }
      ],
      [REGIONS_PROMPT]: [
        LIMITS,
        { text: 'Looking at how the regions are stored first.', rate: 20 },
        { tool: { name: 'Grep', input: { pattern: 'region', path: 'src' }, result: 'Found 14 matches', ms: 800 } },
        { gate: 'regions-end' }
      ]
    }
  }
  const demo = await launchDemo(script, acme, [acme, regions, api])
  const { app, page, pipeName } = demo
  try {
    const acmeTab = (await page.evaluate(() => window.__ct!.activeTabId()))!
    // the work going on before the recording starts: Claude busy in the worktree and in the API server
    const regionsTab = await openTabInFront(page, 'claude', regions)
    await typeMessage(page, REGIONS_PROMPT, false)
    const apiTab = await openTabInFront(page, 'claude', api)
    await typeMessage(page, API_PROMPT, false)
    await page.evaluate((o) => window.ct.openTab(o), { kind: 'shell' as const, cwd: scratch, title: 'PowerShell' })
    await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().length)).toBe(4)
    await page.evaluate((id) => window.ct.activateTab(id), acmeTab)
    await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(acmeTab)
    await typeMessage(page, SALES_PROMPT, false)
    await waitIdle(page, acmeTab)
    await frameWindow(demo)
    await chart(page, join(reports, 'revenue-2026.png'), {
      title: 'Revenue by month, 2026', subtitle: 'Net revenue, thousands of USD', kind: 'bars', labels: MONTHS,
      series: [{ name: '2026', color: '#d97757', values: REVENUE_2026 }]
    })
    await chart(page, join(reports, 'revenue-yoy.png'), {
      title: 'Year over year', subtitle: 'Net revenue, thousands of USD', kind: 'lines', labels: MONTHS,
      series: [{ name: '2025', color: '#8a8a93', values: REVENUE_2025 }, { name: '2026', color: '#d97757', values: REVENUE_2026 }]
    })
    await keepGroups(page, { [acmeTab]: 'acme-dashboard', [regionsTab]: 'acme-dashboard', [apiTab]: 'api-server' })
    await installPointer(page, { x: 760, y: 430 })
    await page.waitForTimeout(1500)

    const rec = await Recording.start(page, framesDir(root, 'overview'))
    rec.caption('Every Claude Code session in a tab, grouped by project and branch')
    await page.waitForTimeout(2800)
    rec.caption('Your 5-hour and weekly limits, always in view')
    await glideTo(page, 820, 22)
    await page.waitForTimeout(1600)

    rec.caption('A chat with Claude: every tool call is a step you can open')
    await typeMessage(page, CHART_PROMPT)
    await glideTo(page, 760, 470)
    await waitCall(page, acmeTab, 'Bash', true)
    rec.caption('Charts and screenshots Claude makes appear in the Media panel')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId: acmeTab, path: join(reports, 'revenue-2026.png'), caption: 'Revenue by month, 2026' })).toEqual({ ok: true })
    await page.waitForTimeout(400)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId: acmeTab, path: join(reports, 'revenue-yoy.png'), caption: 'Year over year' })).toEqual({ ok: true })
    await waitCall(page, acmeTab, 'Agent')
    await page.waitForTimeout(1600)
    rec.caption('Subagents at work, with their model, effort and time')
    await page.waitForTimeout(3000)

    rec.caption('A click opens the full-size viewer')
    await glideAndClick(page, '#image-panel .card img')
    await expect(page.locator('#lightbox')).toBeVisible()
    await page.waitForTimeout(1800)
    await page.keyboard.press('Escape')
    await expect(page.locator('#lightbox')).toBeHidden()

    await expect(page.locator('.chat-host:visible .chat-card-question')).toHaveCount(1, { timeout: 30_000 })
    rec.caption("Claude's questions come as cards: answer with a click")
    await page.waitForTimeout(900)
    await glideAndClick(page, '.chat-host:visible .chat-card-question .chat-card-option')
    await page.waitForTimeout(400)
    await glideAndClick(page, '.chat-host:visible .chat-card button:has-text("Submit")')
    await waitIdle(page, acmeTab)
    await page.waitForTimeout(1200)
    // the panel goes, so the permission card of the next tab has the room
    await glideAndClick(page, '.tab-images-toggle:visible')

    release(demo, 'api-ask')
    // the permission request is up: Claude Code's Notification hook would now tell ClaudeTerm, and the stand-in runs no hooks
    await expect.poll(() => page.evaluate(async (id) => {
      const s = await window.ct.chatSnapshot(id)
      return (s?.items ?? []).some((item) => item.kind === 'card' && item.answered === null)
    }, apiTab), { timeout: 15_000 }).toBe(true)
    await hook(demo, apiTab, 'permission')
    const apiRow = `#tabpanel .tp-tab[data-tab-id="${apiTab}"]`
    await expect(page.locator(apiRow)).toHaveClass(/\battention\b/, { timeout: 15_000 })
    rec.caption('A tab where Claude waits for you pulses')
    const rowBox = (await page.locator(apiRow).boundingBox())!
    await glideTo(page, 330, Math.round(rowBox.y + rowBox.height / 2))
    await page.waitForTimeout(2200)
    await glideAndClick(page, apiRow, { x: 120, y: rowBox.height / 2 })
    await expect(page.locator('.chat-host:visible .chat-card-permission')).toHaveCount(1)
    rec.caption('Permission requests, right in the chat')
    await page.waitForTimeout(1400)
    await glideAndClick(page, '.chat-host:visible .chat-card-permission button:has-text("Allow once")')
    await glideTo(page, 760, 520)
    await expect(page.locator('.chat-host:visible .chat-column')).toContainText('the tests pass', { timeout: 20_000 })
    await page.waitForTimeout(2600)
    await groupsKept(page)
    await rec.finish(join(OUT, 'demo.gif'))
  } finally {
    await app.close()
  }
})

const REVENUE_BEFORE = `import { monthlyRevenue } from '../data/sales'

export function revenueByMonth(year: number) {
  const rows = monthlyRevenue(year)
  return rows.map((r) => r.total)
}

export function growth(now: number[], before: number[]) {
  return now.map((v, i) => v / before[i] - 1)
}
`
const REVENUE_AFTER = REVENUE_BEFORE
  .replace('rows.map((r) => r.total)', 'rows.map((r) => Math.round(r.total / 1000))')
  .replace('v / before[i] - 1', '(before[i] ? v / before[i] - 1 : 0)')
/** after Claude took the comment: the totals stay raw, the chart labels round them */
const REVENUE_FIXED = REVENUE_AFTER.replace('Math.round(r.total / 1000)', 'r.total')
const LABELS = 'export const k = (v: number) => `$${Math.round(v / 1000)}k`\n'
const YOY = `import { growth, revenueByMonth } from './revenue'

export function yearOverYear(year: number) {
  return growth(revenueByMonth(year), revenueByMonth(year - 1))
}
`
const SPEC = `# Revenue dashboard

## Goals

- Monthly revenue for the current year, in thousands of dollars
- A year-over-year view, with the growth of each month
- Q3 by region, 2025 next to 2026

## Data

| Source | Refreshed | Owner |
|---|---|---|
| \`data/sales-*.csv\` | nightly | Finance |
| \`data/regions.csv\` | weekly | Sales ops |

## Open questions

1. Should refunds count in the month of the sale or of the refund?
2. Do we show the forecast for Q4?
`

const EDIT_PROMPT = 'Show the chart in thousands and add a year-over-year view'
const SPEC_PROMPT = 'Show me the dashboard spec'
const COMMENT = 'Keep the raw totals: the CSV export reads them. Round in the labels.'

test('review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-gif-work-'))
  const acme = repo(join(root, 'acme-dashboard'), {
    'src/charts/revenue.ts': REVENUE_BEFORE,
    'docs/spec.md': SPEC,
    'README.md': '# Acme dashboard\n'
  })
  const api = repo(join(root, 'api-server'), { 'src/routes/orders.ts': 'export {}\n' })

  const script: FakeScript = {
    ...CONTEXT,
    turns: {
      [EDIT_PROMPT]: [
        LIMITS,
        { tool: { name: 'Edit', input: { file_path: 'src/charts/revenue.ts', old_string: 'rows.map((r) => r.total)', new_string: 'rows.map((r) => Math.round(r.total / 1000))' }, result: 'The file has been updated successfully.', ms: 300 } },
        { tool: { name: 'Write', input: { file_path: 'src/charts/yoy.ts', content: YOY }, result: 'File created', ms: 300 } },
        { text: 'The chart is in thousands now, and `yoy.ts` gives the growth of each month over last year.' }
      ],
      [SPEC_PROMPT]: [
        { text: 'Here it is, in the Docs panel.', rate: 20 }
      ]
    },
    // the comments Send to Claude writes: Claude takes them
    fallback: [
      { text: 'Good point. I will keep the raw totals in `revenue.ts` and round in a label helper instead.', rate: 26 },
      { tool: { name: 'Edit', input: { file_path: 'src/charts/revenue.ts', old_string: 'Math.round(r.total / 1000)', new_string: 'r.total' }, result: 'The file has been updated successfully.', ms: 1400 } },
      { tool: { name: 'Write', input: { file_path: 'src/charts/labels.ts', content: LABELS }, result: 'File created', ms: 900 } },
      { text: 'Done: `revenueByMonth()` returns the raw totals again, and `labels.ts` rounds them for the chart.', rate: 30 }
    ]
  }
  const demo = await launchDemo(script, acme, [acme, api], { review: { width: 540, fileTree: false } }, 220)
  const { app, page, pipeName } = demo
  try {
    const acmeTab = (await page.evaluate(() => window.__ct!.activeTabId()))!
    const apiTab = await openTabInFront(page, 'claude', api)
    await page.evaluate((id) => window.ct.activateTab(id), acmeTab)
    await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(acmeTab)
    // Claude's earlier turn, and its edits on disk
    await typeMessage(page, EDIT_PROMPT, false)
    writeFiles(acme, { 'src/charts/revenue.ts': REVENUE_AFTER, 'src/charts/yoy.ts': YOY })
    await waitCall(page, acmeTab, 'Write', true)
    await waitIdle(page, acmeTab)
    await hook(demo, acmeTab, 'session')
    await frameWindow(demo)
    await keepGroups(page, { [acmeTab]: 'acme-dashboard', [apiTab]: 'api-server' })
    await installPointer(page, { x: 640, y: 430 })
    await page.waitForTimeout(1500)

    const rec = await Recording.start(page, framesDir(root, 'review'))
    rec.caption("Review Claude's changes beside the conversation")
    await page.waitForTimeout(1200)
    await glideAndClick(page, '.tab-changes-toggle:visible')
    const revenue = page.locator('.review-file[data-path="src/charts/revenue.ts"]')
    await expect(revenue.locator('.review-line.add')).toHaveCount(2, { timeout: 15_000 })
    await page.waitForTimeout(1800)

    rec.caption('Comment on any line')
    const row = revenue.locator('.review-line.add').first()
    const rowBox = (await row.boundingBox())!
    await glideTo(page, Math.round(rowBox.x + rowBox.width / 2), Math.round(rowBox.y + rowBox.height / 2))
    await row.hover()
    await page.waitForTimeout(500)
    await glideAndClick(page, '.review-line.add >> nth=0 >> .review-plus')
    await page.locator('.review-comment-input').click()
    await page.keyboard.type(COMMENT, { delay: 22 })
    await page.waitForTimeout(400)
    await glideAndClick(page, '.review-btn.primary')
    await expect(page.locator('.review-count')).toHaveText('1 comment')
    await page.waitForTimeout(900)

    rec.caption('Send to Claude: it gets the file, the line and the code')
    await expect(page.locator('.review-send')).toBeEnabled()
    await glideAndClick(page, '.review-send')
    await waitCall(page, acmeTab, 'Edit', false, 2)
    // Claude's edit lands on disk while its step runs
    await page.waitForTimeout(700)
    writeFiles(acme, { 'src/charts/revenue.ts': REVENUE_FIXED })
    await refreshChanges(page, acmeTab)
    rec.caption('The diff follows Claude as it works')
    await waitCall(page, acmeTab, 'Write', false, 2)
    await page.waitForTimeout(500)
    writeFiles(acme, { 'src/charts/labels.ts': LABELS })
    await refreshChanges(page, acmeTab)
    await waitCall(page, acmeTab, 'Write', true, 2)
    await waitIdle(page, acmeTab)
    await hook(demo, acmeTab, 'done')
    await expect(page.locator('.review-file[data-path="src/charts/labels.ts"]')).toHaveCount(1, { timeout: 15_000 })
    await page.waitForTimeout(2200)

    rec.caption('Documents Claude shows you open formatted, in the Docs panel')
    await typeMessage(page, SPEC_PROMPT)
    await expect(page.locator('.chat-host:visible .chat-column')).toContainText('in the Docs panel', { timeout: 15_000 })
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_document', tabId: acmeTab, path: join(acme, 'docs', 'spec.md'), title: 'Dashboard spec' })).toMatchObject({ ok: true })
    await expect(page.locator('.doc-md h1')).toHaveText('Revenue dashboard', { timeout: 15_000 })
    await glideTo(page, 1000, 420)
    await page.waitForTimeout(3200)
    await groupsKept(page)
    await rec.finish(join(OUT, 'review.gif'))
  } finally {
    await app.close()
  }
})
