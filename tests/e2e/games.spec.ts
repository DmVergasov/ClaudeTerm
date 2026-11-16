import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatReady, CHAT_INPUT, launchChatTab, sendMessage } from './chat-helpers'
import { KEY_LABELS, KEYS, launchApp, makeDataDir, openTabInFront } from './helpers'

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']

/** the game window over the terminal, and the Games toggle of the sheet header */
const win = (page: Page) => page.locator('#games .games-window')
const toggle = (page: Page) => page.locator('#sheet-header .tab-games-toggle')
const board = (page: Page) => page.locator('#games .merge-board')

/** the input of the terminal in front */
const terminalInput = (page: Page) => page.locator('.terminal-host:visible .xterm-helper-textarea')

/** everything written to the terminal in front */
const ptyInput = (page: Page): Promise<string> => page.evaluate(() => window.__ct!.ptyInput!())

/** opens the game menu and picks the game in it */
async function pick(page: Page, game: 'runner' | 'merge' | 'clicker'): Promise<void> {
  await page.locator('#games .games-name').click()
  await page.locator(`#games .games-menu-item[data-game="${game}"]`).click()
}

test('Runner starts with Space and pauses itself when the tab takes the keyboard', async () => {
  const { app, page } = await launchApp()
  const runner = page.locator('#games .runner')
  await toggle(page).click()
  await expect(win(page)).toHaveAttribute('data-game', 'runner')
  await expect(runner).toHaveAttribute('data-phase', 'ready')

  await page.keyboard.press('Space')
  await expect(runner).toHaveAttribute('data-phase', 'running')

  await page.locator('.terminal-host:visible .xterm').click()
  await expect(win(page)).toHaveAttribute('data-keyboard', 'tab')
  await expect(win(page)).toHaveAttribute('data-paused', 'true')

  await win(page).click({ position: { x: 150, y: 220 } })
  await expect(win(page)).toHaveAttribute('data-keyboard', 'game')
  await expect(win(page)).toHaveAttribute('data-paused', 'true')

  await page.keyboard.press('Space')
  await expect(win(page)).toHaveAttribute('data-paused', 'false')
  await app.close()
})

test('switching games pauses the game you leave, and it comes back paused', async () => {
  const { app, page } = await launchApp()
  const runner = page.locator('#games .runner')
  await toggle(page).click()
  // a run ends about 1.2 s after it starts when Clawd does not jump, so a switch can find it over: the start and the switch
  // are tried again, up to three times
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press('Space')
    await pick(page, 'merge')
    await expect(win(page)).toHaveAttribute('data-game', 'merge')
    await pick(page, 'runner')
    if ((await runner.getAttribute('data-phase')) === 'running') break
  }
  await expect(win(page)).toHaveAttribute('data-paused', 'true')
  await expect(runner).toHaveAttribute('data-phase', 'running')
  await app.close()
})

test('a fresh Runner waits in Ready: it is not paused when the tab takes the keyboard, and one Space starts it', async () => {
  const { app, page } = await launchApp()
  const runner = page.locator('#games .runner')
  await toggle(page).click()
  await expect(runner).toHaveAttribute('data-phase', 'ready')

  await page.locator('.terminal-host:visible .xterm').click()
  await expect(win(page)).toHaveAttribute('data-keyboard', 'tab')
  await expect(win(page)).toHaveAttribute('data-paused', 'false')

  await win(page).click({ position: { x: 150, y: 220 } })
  await page.keyboard.press('Space')
  await expect(runner).toHaveAttribute('data-phase', 'running')
  await app.close()
})

test('an open game menu closes on Esc, and when the keyboard leaves the window', async () => {
  const { app, page } = await launchApp()
  const menu = page.locator('#games .games-menu')
  await toggle(page).click()

  await page.locator('#games .games-name').click()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(win(page)).toHaveAttribute('data-keyboard', 'tab')

  await page.locator('#games .games-name').click()
  await expect(menu).toBeVisible()
  await page.locator('.terminal-host:visible .xterm').click()
  await expect(win(page)).toHaveAttribute('data-keyboard', 'tab')
  await expect(menu).toBeHidden()
  await app.close()
})

test('the Games toggle and the shortcut open and close the game window', async () => {
  const { app, page } = await launchApp()
  await expect(toggle(page)).toHaveAttribute('title', `Games (${KEY_LABELS.games})`)
  await expect(toggle(page)).not.toHaveClass(/active/)

  await toggle(page).click()
  await expect(win(page)).toBeVisible()
  await expect(win(page)).toBeFocused()
  await expect(toggle(page)).toHaveClass(/active/)

  await page.keyboard.press(KEYS.games)
  await expect(win(page)).toBeHidden()
  await expect(toggle(page)).not.toHaveClass(/active/)
  await expect(terminalInput(page)).toBeFocused()

  await page.keyboard.press(KEYS.games)
  await expect(win(page)).toBeVisible()
  await app.close()
})

test('Merge takes the arrows and drops other keys; nothing reaches the tab', async () => {
  const { app, page } = await launchApp()
  await toggle(page).click()
  await pick(page, 'merge')
  await expect(win(page)).toBeFocused()

  const before = await ptyInput(page)
  const start = await board(page).getAttribute('data-cells')
  for (const key of ARROWS) await page.keyboard.press(key)
  await page.keyboard.press('KeyX')
  await page.keyboard.press('Enter')

  await expect.poll(() => board(page).getAttribute('data-cells')).not.toBe(start)
  expect(await ptyInput(page)).toBe(before)
  await app.close()
})

test('a click in the terminal takes the keyboard back, a click in the window gives it to the game, Esc gives it back', async () => {
  const { app, page } = await launchApp()
  await toggle(page).click()
  await pick(page, 'merge')
  await expect(win(page)).toHaveAttribute('data-keyboard', 'game')
  await expect(page.locator('#games .games-tip')).toBeHidden()

  await page.locator('.terminal-host:visible .xterm').click()
  await expect(win(page)).toHaveAttribute('data-keyboard', 'tab')
  await expect(page.locator('#games .games-tip')).toBeVisible()
  await page.keyboard.type('echo games')
  await expect.poll(() => ptyInput(page)).toContain('echo games')

  await win(page).click({ position: { x: 150, y: 220 } })
  await expect(win(page)).toHaveAttribute('data-keyboard', 'game')
  await expect(page.locator('#games .games-tip')).toBeHidden()

  await page.keyboard.press('Escape')
  await expect(win(page)).toHaveAttribute('data-keyboard', 'tab')
  await expect(terminalInput(page)).toBeFocused()
  await app.close()
})

test('auto-repeated keys are dropped', async () => {
  // a lone tile in the second column: the first ArrowLeft always moves it (a fresh random board may not move left)
  const dataDir = mergeDataDir({ board: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], score: 0, best: 0, won: false })
  const { app, page } = await launchApp({ dataDir })
  await toggle(page).click()
  await pick(page, 'merge')

  // one real press moves the board, so the repeats below are compared with a board that changes
  const start = await board(page).getAttribute('data-cells')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => board(page).getAttribute('data-cells')).not.toBe(start)
  const moved = await board(page).getAttribute('data-cells')

  await page.evaluate((codes) => {
    const el = document.querySelector('#games .games-window')!
    for (const code of codes) el.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, repeat: true, bubbles: true }))
  }, ARROWS)
  expect(await board(page).getAttribute('data-cells')).toBe(moved)
  await app.close()
})

test('app shortcuts work while the game has the keyboard, and a tab switch gives the keyboard to the new tab', async () => {
  const { app, page } = await launchApp()
  await toggle(page).click()
  await pick(page, 'merge')
  await expect(win(page)).toHaveAttribute('data-keyboard', 'game')

  const first = await page.evaluate(() => window.__ct!.activeTabId())
  await page.keyboard.press(KEYS.newTab)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, first)

  await expect(win(page)).toHaveAttribute('data-keyboard', 'tab')
  await expect(win(page)).toBeVisible()
  await app.close()
})

test('pause, fold and close keep the game', async () => {
  const { app, page } = await launchApp()
  await toggle(page).click()
  await pick(page, 'merge')
  const start = await board(page).getAttribute('data-cells')

  await page.locator('#games .games-pause').click()
  await expect(win(page)).toHaveAttribute('data-paused', 'true')
  await expect(page.locator('#games .games-paused')).toBeVisible()
  for (const key of ARROWS) await page.keyboard.press(key)
  expect(await board(page).getAttribute('data-cells')).toBe(start)

  await page.keyboard.press('Space')
  await expect(win(page)).toHaveAttribute('data-paused', 'false')

  await page.locator('#games .games-fold').click()
  await expect(win(page)).toBeHidden()
  await expect(page.locator('#games .games-pill')).toBeVisible()
  await expect(page.locator('#games .games-pill')).toContainText('Merge')
  await expect(page.locator('#games .games-pill')).toContainText('paused')

  await page.locator('#games .games-pill').click()
  await expect(win(page)).toBeVisible()
  await expect(win(page)).toBeFocused()
  await expect(win(page)).toHaveAttribute('data-paused', 'true')

  await page.locator('#games .games-close').click()
  await expect(win(page)).toBeHidden()

  await toggle(page).click()
  await expect(win(page)).toBeVisible()
  await expect(board(page)).toHaveAttribute('data-cells', start!)
  await app.close()
})

/** the Merge board the data folder's games.json holds, as the window writes it; empty while there is no such save */
function savedBoard(dataDir: string): string {
  try {
    const save = JSON.parse(readFileSync(join(dataDir, 'games.json'), 'utf8'))
    return (save.merge?.board ?? []).join(',')
  } catch {
    return ''
  }
}

/** a data folder whose Merge save is `merge`: the game window opens on it */
function mergeDataDir(merge: object): string {
  const dir = makeDataDir()
  writeFileSync(join(dir, 'games.json'), JSON.stringify({ game: 'merge', runnerBest: 0, merge, clicker: null }))
  return dir
}

test('two 512 KB tiles that slide together make 1 MB: the goal note shows until Keep going', async () => {
  const dataDir = mergeDataDir({ board: [10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], score: 0, best: 0, won: false })
  const { app, page } = await launchApp({ dataDir })
  await toggle(page).click()
  await pick(page, 'merge')
  await expect(page.locator('#games .merge-goal')).toBeHidden()

  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('#games .merge-goal')).toBeVisible()
  await expect(page.locator('#games .merge-goal span')).toHaveText('1 MB!')
  await expect(board(page)).toHaveAttribute('data-cells', /^11,/)

  await page.locator('#games .merge-keep').click()
  await expect(page.locator('#games .merge-goal')).toBeHidden()
  await app.close()
})

test('a full board with no merge says No moves, and New game starts over keeping the best', async () => {
  const stuck = [1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2, 1]
  const dataDir = mergeDataDir({ board: stuck, score: 1240, best: 3311, won: false })
  const { app, page } = await launchApp({ dataDir })
  await toggle(page).click()
  await pick(page, 'merge')
  await expect(page.locator('#games .merge-stuck')).toBeVisible()
  await expect(page.locator('#games .merge-stuck')).toHaveText('No moves')
  await expect(page.locator('#games .merge-best')).toHaveText('best 3,311')
  await expect(page.locator('#games .merge-score')).toHaveText('score 1,240')

  await page.locator('#games .merge-new').click()
  await expect(page.locator('#games .merge-stuck')).toBeHidden()
  await expect(page.locator('#games .merge-score')).toHaveText('score 0')
  await expect(page.locator('#games .merge-best')).toHaveText('best 3,311')
  await app.close()
})

test('every Merge cell is the same square, whichever cells hold tiles', async () => {
  const dataDir = mergeDataDir({ board: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 2], score: 0, best: 0, won: false })
  const { app, page } = await launchApp({ dataDir })
  await toggle(page).click()
  await pick(page, 'merge')
  await expect(board(page)).toHaveAttribute('data-cells', '0,0,0,0,0,0,1,0,0,0,0,1,0,1,0,2')

  const sizes = await page.evaluate(() =>
    [...document.querySelectorAll('#games .merge-cell')].map((c) => {
      const r = c.getBoundingClientRect()
      return { w: r.width, h: r.height }
    })
  )
  expect(sizes).toHaveLength(16)
  for (const s of sizes) {
    expect(Math.abs(s.w - sizes[0].w)).toBeLessThan(0.5)
    expect(Math.abs(s.h - sizes[0].w)).toBeLessThan(0.5)
  }
  await app.close()
})

/** presses the arrows in one go on the game window and reads the board in the same call, before anything is drawn again */
function pressAndRead(page: Page, codes: string[]): Promise<{ ghosts: string[]; cells: string; arriving: number }> {
  return page.evaluate((keys) => {
    const el = document.querySelector('#games .games-window')!
    for (const code of keys) el.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }))
    return {
      ghosts: [...document.querySelectorAll('#games .merge-ghost')].map((g) => (g as HTMLElement).dataset.e!),
      cells: (document.querySelector('#games .merge-board') as HTMLElement).dataset.cells!,
      arriving: document.querySelectorAll('#games [data-arriving]').length
    }
  }, codes)
}

const ROW_OF_ONES = { board: [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], score: 0, best: 0, won: false }

test('a Merge move slides its tiles: ghosts go from their cells to where the tiles end, then the board shows the result', async () => {
  const { app, page } = await launchApp({ dataDir: mergeDataDir(ROW_OF_ONES) })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await toggle(page).click()
  await pick(page, 'merge')

  const seen = await pressAndRead(page, ['ArrowLeft'])
  expect(seen.ghosts).toEqual(['1', '1'])
  const cells = seen.cells.split(',').map(Number)
  expect(cells[0]).toBe(2)
  expect(cells.filter((c) => c !== 0)).toHaveLength(2)
  expect(seen.arriving).toBeGreaterThan(0)

  await expect.poll(() => page.locator('#games .merge-ghost').count()).toBe(0)
  await expect.poll(() => page.locator('#games [data-arriving]').count()).toBe(0)
  await expect(board(page)).toHaveAttribute('data-cells', seen.cells)
  await app.close()
})

test('with reduced motion a Merge move draws the result with no ghosts', async () => {
  const { app, page } = await launchApp({ dataDir: mergeDataDir(ROW_OF_ONES) })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await toggle(page).click()
  await pick(page, 'merge')

  const seen = await pressAndRead(page, ['ArrowLeft'])
  expect(seen.ghosts).toEqual([])
  expect(seen.arriving).toBe(0)
  const cells = seen.cells.split(',').map(Number)
  expect(cells[0]).toBe(2)
  expect(cells.filter((c) => c !== 0)).toHaveLength(2)
  await app.close()
})

test('a second move while the first still slides settles the first at once', async () => {
  // Left merges the pair into cell 0; Right then moves the result (and the tile Left spawned) again
  const { app, page } = await launchApp({ dataDir: mergeDataDir(ROW_OF_ONES) })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await toggle(page).click()
  await pick(page, 'merge')

  const seen = await page.evaluate(() => {
    const el = document.querySelector('#games .games-window')!
    const press = (code: string) => el.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }))
    const read = () => {
      const b = document.querySelector('#games .merge-board') as HTMLElement
      const cells = b.dataset.cells!
      return { cells, ghosts: b.querySelectorAll('.merge-ghost').length, tiles: cells.split(',').filter((c) => c !== '0').length }
    }
    press('ArrowLeft')
    const first = read()
    press('ArrowRight')
    return { first, second: read() }
  })
  expect(seen.first.ghosts).toBe(2)
  expect(seen.second.cells).not.toBe(seen.first.cells)
  // the second move slid every tile the first one left (two of them), and only those ghosts exist
  expect(seen.second.ghosts).toBe(seen.first.tiles)
  expect(seen.second.cells.split(',').map(Number)[3]).toBeGreaterThan(0)

  await expect.poll(() => page.locator('#games .merge-ghost').count()).toBe(0)
  await expect.poll(() => page.locator('#games [data-arriving]').count()).toBe(0)
  await expect(board(page)).toHaveAttribute('data-cells', seen.second.cells)
  await app.close()
})

/** a data folder whose Clicker save is `clicker`: the game window opens on it */
function clickerDataDir(clicker: object): string {
  const dir = makeDataDir()
  writeFileSync(join(dir, 'games.json'), JSON.stringify({ game: 'clicker', runnerBest: 0, merge: null, clicker }))
  return dir
}

test('a click on Clawd writes a line; an Intern costs 15 and then writes lines by itself', async () => {
  const { app, page } = await launchApp()
  await toggle(page).click()
  await pick(page, 'clicker')
  await expect(win(page)).toHaveAttribute('data-game', 'clicker')
  await expect(page.locator('#games .games-pause')).toBeDisabled()

  for (let i = 0; i < 15; i++) await page.locator('#games .clicker-clawd').click()
  await expect(page.locator('#games .clicker-count')).toHaveText('15')

  await page.locator('#games .clicker-buy[data-helper="0"]').click()
  await expect(page.locator('#games .clicker-count')).toHaveText('0')
  await expect(page.locator('#games .clicker-rate')).toHaveText('+1 per second')
  await expect.poll(async () => Number(await page.locator('#games .clicker-count').textContent()), { timeout: 3000 }).toBeGreaterThanOrEqual(1)
  await app.close()
})

test('the Clicker stops counting while the app is in the background, and catches up when it is back', async () => {
  const { app, page } = await launchApp({ dataDir: clickerDataDir({ lines: 50, helpers: [1, 0, 0, 0], at: Date.now() }) })
  await toggle(page).click()
  await expect(win(page)).toHaveAttribute('data-game', 'clicker')
  const count = page.locator('#games .clicker-count')
  await expect.poll(async () => Number(await count.textContent())).toBeGreaterThanOrEqual(50)

  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  const blurred = await count.textContent()
  await page.waitForTimeout(1500)
  expect(await count.textContent()).toBe(blurred)

  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(async () => Number(await count.textContent())).toBeGreaterThanOrEqual(Number(blurred) + 1)
  await app.close()
})

test('lines written while the app was closed are counted, at most 8 hours', async () => {
  const hours = (h: number) => Date.now() - h * 3600_000

  const { app, page } = await launchApp({ dataDir: clickerDataDir({ lines: 0, helpers: [1, 0, 0, 0], at: hours(2) }) })
  await toggle(page).click()
  await expect(page.locator('#games .clicker-away')).toContainText('+7.2K lines while you were away')
  await app.close()

  // ten hours away earn eight: the absence is capped
  const capped = await launchApp({ dataDir: clickerDataDir({ lines: 0, helpers: [1, 0, 0, 0], at: hours(10) }) })
  await toggle(capped.page).click()
  await expect(capped.page.locator('#games .clicker-away')).toContainText('+28.8K lines while you were away')
  await capped.app.close()
})

test('the away note survives opening the menu before the Clicker is shown', async () => {
  const dataDir = makeDataDir()
  writeFileSync(join(dataDir, 'games.json'), JSON.stringify({
    game: 'runner',
    runnerBest: 0,
    merge: null,
    clicker: { lines: 0, helpers: [1, 0, 0, 0], at: Date.now() - 2 * 3600_000 }
  }))
  const { app, page } = await launchApp({ dataDir })
  await toggle(page).click()
  await expect(win(page)).toHaveAttribute('data-game', 'runner')

  // opening the menu reads the Clicker's count and saves the games: both bring its lines up to date
  await pick(page, 'clicker')
  await expect(win(page)).toHaveAttribute('data-game', 'clicker')
  await expect(page.locator('#games .clicker-away')).toContainText('+7.2K lines while you were away')
  await app.close()
})

/** closes the app's window and waits for the app to close, as the other specs do */
async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

test('the window stays left of the side panel', async () => {
  const { app, page } = await launchApp()
  await page.keyboard.press(KEYS.images)
  await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
  await toggle(page).click()
  await expect(win(page)).toBeVisible()

  const window = await win(page).boundingBox()
  const panel = await page.locator('#image-panel').boundingBox()
  expect(window!.x + window!.width).toBeLessThanOrEqual(panel!.x)
  await app.close()
})

test('in a chat tab the window sits above the composer, follows its growth, and sits at the bottom with no composer', async () => {
  const { app, page, work } = await launchChatTab({ turns: { ask: [{ text: 'Answer.' }] } })
  try {
    await chatReady(page)
    await toggle(page).click()
    await expect(win(page)).toBeVisible()

    // the composer shown in front, its height, and the lift the window is given: they must agree
    const lift = () => page.evaluate(() => {
      const composer = [...document.querySelectorAll<HTMLElement>('#terminals .chat-composer')].find((c) => c.offsetParent !== null)
      return { lift: document.documentElement.style.getPropertyValue('--games-lift'), height: composer?.offsetHeight ?? 0 }
    })
    // how far the window's bottom is above the composer's top: at least 0 when the window is clear of it
    const gap = async () => {
      const window = await win(page).boundingBox()
      const composer = await page.locator('.chat-host:visible .chat-composer').boundingBox()
      return composer!.y - (window!.y + window!.height)
    }
    const before = await lift()
    expect(before.lift).toBe(`${before.height}px`)
    expect(await gap()).toBeGreaterThanOrEqual(0)

    // the composer grows by four lines: the window follows it through the observer, without a new place() call
    await page.locator(CHAT_INPUT).click()
    await page.keyboard.type('first line')
    for (const line of ['second', 'third', 'fourth']) {
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type(`${line} line`)
    }
    await expect.poll(async () => {
      const now = await lift()
      return now.height >= before.height + 20 && now.lift === `${now.height}px`
    }).toBe(true)
    expect(await gap()).toBeGreaterThanOrEqual(0)

    // a shell tab shows no composer: the lift goes back to 0 and the window sits 10 px above the bottom of the view
    await openTabInFront(page, 'shell', work)
    await expect(win(page)).toBeVisible()
    await expect.poll(lift).toEqual({ lift: '0px', height: 0 })
    await expect.poll(() => page.evaluate(() => {
      const view = document.getElementById('terminals')!.getBoundingClientRect()
      const window = document.querySelector('#games .games-window')!.getBoundingClientRect()
      return Math.round(view.bottom - window.bottom)
    })).toBe(10)
  } finally {
    await app.close()
  }
})

test('the chat composer\'s menus paint over the game window', async () => {
  const { app, page } = await launchChatTab({ turns: { ask: [{ text: 'Answer.' }] } })
  try {
    await chatReady(page)
    await toggle(page).click()
    await expect(win(page)).toBeVisible()

    // the slash menu opens upward from the composer, where the window sits: a point inside both boxes must be the menu's
    await page.locator(CHAT_INPUT).click()
    await page.keyboard.type('/')
    await expect(page.locator('.chat-host:visible .chat-slash-menu')).toBeVisible()
    const shared = await page.evaluate(() => {
      const menu = [...document.querySelectorAll<HTMLElement>('.chat-slash-menu')].find((e) => e.offsetParent !== null)!
      const m = menu.getBoundingClientRect()
      const w = document.querySelector('#games .games-window')!.getBoundingClientRect()
      const left = Math.max(m.left, w.left)
      const right = Math.min(m.right, w.right)
      const top = Math.max(m.top, w.top)
      const bottom = Math.min(m.bottom, w.bottom)
      return left < right && top < bottom ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null
    })
    expect(shared).not.toBeNull()
    const top = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      return { inMenu: !!el?.closest('.chat-slash-menu'), inGames: !!el?.closest('#games') }
    }, shared!)
    expect(top).toEqual({ inMenu: true, inGames: false })
  } finally {
    await app.close()
  }
})

test('a reply in the chat leaves the keyboard with the game', async () => {
  const { app, page } = await launchChatTab({ turns: { ask: [{ wait: 1500 }, { text: 'Answer.' }] } })
  try {
    await sendMessage(page, 'ask')
    await toggle(page).click()
    await pick(page, 'merge')
    await win(page).click({ position: { x: 150, y: 220 } })
    await expect(win(page)).toHaveAttribute('data-keyboard', 'game')

    await expect(page.locator('.chat-host:visible .chat-text', { hasText: 'Answer.' })).toHaveCount(1)
    await expect(win(page)).toHaveAttribute('data-keyboard', 'game')
    await expect(page.locator(CHAT_INPUT)).not.toBeFocused()
  } finally {
    await app.close()
  }
})

test('games and the last game chosen survive a restart; the window starts closed', async () => {
  const dataDir = makeDataDir()
  const first = await launchApp({ dataDir })
  await toggle(first.page).click()
  await pick(first.page, 'merge')
  const start = await board(first.page).getAttribute('data-cells')
  for (const key of ARROWS) {
    await first.page.keyboard.press(key)
    if ((await board(first.page).getAttribute('data-cells')) !== start) break
  }
  const moved = await board(first.page).getAttribute('data-cells')
  expect(moved).not.toBe(start)

  await first.page.locator('#games .games-close').click()
  await expect(win(first.page)).toBeHidden()
  await closeWindow(first.app)

  const second = await launchApp({ dataDir })
  await expect(win(second.page)).toBeHidden()
  await second.page.keyboard.press(KEYS.games)
  await expect(win(second.page)).toBeVisible()
  await expect(win(second.page)).toHaveAttribute('data-game', 'merge')
  await expect(board(second.page)).toHaveAttribute('data-cells', moved!)
  await second.app.close()
})

test('a move survives a restart even when the app closes without closing the game', async () => {
  const dataDir = makeDataDir()
  const first = await launchApp({ dataDir })
  await toggle(first.page).click()
  await pick(first.page, 'merge')
  const start = await board(first.page).getAttribute('data-cells')
  for (const key of ARROWS) {
    await first.page.keyboard.press(key)
    if ((await board(first.page).getAttribute('data-cells')) !== start) break
  }
  const moved = await board(first.page).getAttribute('data-cells')
  expect(moved).not.toBe(start)

  // the save is written 2 s after the last change: the app closes once the file holds the moved board
  await expect.poll(() => savedBoard(dataDir)).toBe(moved)
  await closeWindow(first.app)

  const second = await launchApp({ dataDir })
  await second.page.keyboard.press(KEYS.games)
  await expect(win(second.page)).toBeVisible()
  await expect(board(second.page)).toHaveAttribute('data-cells', moved!)
  await second.app.close()
})
