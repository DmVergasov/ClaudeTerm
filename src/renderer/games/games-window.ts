import type { GameId, GamesSave } from '../../shared/games'
import { icon } from '../icons'
import { ArtilleryView } from './artillery-view'
import { ClickerView } from './clicker-view'
import type { GameView } from './game-view'
import { gameKeyRoute } from './game-keys'
import { LanderView } from './lander-view'
import { MergeView } from './merge-view'
import { PinballView } from './pinball-view'
import { RunnerView } from './runner-view'
import { SandView } from './sand-view'
import './games.css'

export type GamesWindowState = 'closed' | 'open' | 'folded'

export interface GamesWindowCallbacks {
  load(): Promise<GamesSave>
  save(save: GamesSave): void
  /** the keyboard goes back to the tab in front */
  focusTab(): void
  /** opened, folded or closed: the sheet header's Games toggle follows */
  changed(): void
}

/** a change of a game is written this long after it, so that a run of moves is one write */
const SAVE_DELAY_MS = 2000

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  e.textContent = text
  return e
}

/**
 * The game window: one window over the terminal that holds the games and shows one at a time. It takes the keyboard when
 * it is clicked or opened and gives it back on Esc or a click in the tab; a game is paused while it is folded, closed or
 * has no keyboard. Folded, it is a pill in the same corner that unfolds on a click.
 */
export class GamesWindow {
  private readonly win = el('div', 'games-window')
  private readonly pill = el('button', 'games-pill')
  private readonly name = el('button', 'games-name')
  private readonly title = el('span', 'games-title')
  private readonly menu = el('div', 'games-menu')
  private readonly slot = el('div', 'games-view')
  private readonly overlay = el('div', 'games-paused')
  private readonly pauseButton = el('button', 'games-pause')
  private views: GameView[] = []
  private current: GameView | null = null
  private save: GamesSave | null = null
  private phase: GamesWindowState = 'closed'
  /** each game's pause: a game that is left is paused, and it comes back as it was */
  private readonly paused = new Map<GameId, boolean>()
  private keyboard: 'game' | 'tab' = 'tab'
  private appFocused = document.hasFocus()
  private saveTimer: number | null = null
  /** the shown chat composer the window is lifted above, and the observer that follows its growth */
  private lifted: HTMLElement | null = null
  private readonly grow = new ResizeObserver(() => this.lift())

  constructor(private readonly root: HTMLElement, private readonly cb: GamesWindowCallbacks, private readonly platform: string) {
    this.win.tabIndex = 0
    this.win.hidden = true
    this.pill.hidden = true
    this.menu.hidden = true

    const head = el('div', 'games-head')
    this.name.append(this.title, el('span', 'games-caret', '▾'))
    this.name.addEventListener('click', () => (this.menu.hidden ? this.openMenu() : this.closeMenu()))
    this.pauseButton.addEventListener('click', () => this.togglePause())
    const fold = el('button', 'games-fold', '–')
    fold.title = 'Fold'
    fold.addEventListener('click', () => this.hide('folded'))
    const close = el('button', 'games-close', '✕')
    close.title = 'Close'
    close.addEventListener('click', () => this.hide('closed'))
    head.append(this.name, this.pauseButton, fold, close)

    const body = el('div', 'games-body')
    this.overlay.append(el('b', '', 'Paused'), el('span', '', '▶ or Space to resume'))
    body.append(this.slot, this.overlay)

    this.win.append(el('div', 'games-tip', 'Click to play'), head, this.menu, body)
    this.root.append(this.win, this.pill)

    this.pill.addEventListener('click', () => this.open())
    this.win.addEventListener('keydown', (e) => this.onKey(e, true))
    this.win.addEventListener('keyup', (e) => this.onKey(e, false))
    this.win.addEventListener('focusin', () => {
      this.keyboard = 'game'
      this.draw()
    })
    this.win.addEventListener('focusout', (e) => {
      if (this.win.contains(e.relatedTarget as Node | null)) return
      this.keyboard = 'tab'
      this.pauseOnLeave()
      this.closeMenu()
      this.draw()
    })
    // a click elsewhere in the window closes the menu; a click on its own name or rows keeps it
    this.win.addEventListener('mousedown', (e) => {
      if (!(e.target as Element).closest('.games-name, .games-menu')) this.closeMenu()
    })
    window.addEventListener('focus', () => {
      this.appFocused = true
      this.draw()
    })
    window.addEventListener('blur', () => {
      this.appFocused = false
      this.pauseOnLeave()
      this.draw()
    })
    window.addEventListener('beforeunload', () => this.saveNow())
  }

  /** loads the save; until it has, toggle() does nothing */
  async init(): Promise<void> {
    const save = await this.cb.load()
    this.save = save
    this.views = [
      new RunnerView(save.runnerBest, () => this.changed()),
      new MergeView(save.merge, () => this.changed()),
      new ClickerView(save.clicker, () => this.changed()),
      new LanderView(save.landerBest, () => this.changed()),
      new PinballView(save.pinballBest, () => this.changed()),
      new SandView(save.sandBest, () => this.changed()),
      new ArtilleryView({ wins: save.artilleryWins, streak: save.artilleryStreak, best: save.artilleryBest }, () => this.changed())
    ]
    this.current = this.views.find((v) => v.id === save.game) ?? this.views[0]
    this.draw()
  }

  state(): GamesWindowState {
    return this.phase
  }

  /** closed → open (the game takes the keyboard); open or folded → closed */
  toggle(): void {
    if (this.current === null) return
    if (this.phase === 'closed') this.open()
    else this.hide('closed')
  }

  /** lifts the window above the chat composer of the tab in front, if one is shown: --games-lift is the composer's height */
  place(): void {
    const composer = this.shownComposer()
    if (composer !== this.lifted) {
      this.grow.disconnect()
      this.lifted = composer
      if (composer !== null) this.grow.observe(composer)
    }
    this.lift()
  }

  /** the box along the bottom of the tab in front that the window lifts above: its chat composer, or an agent page's message box */
  private shownComposer(): HTMLElement | null {
    for (const composer of document.querySelectorAll<HTMLElement>('#terminals .chat-composer, #terminals .agent-footer')) {
      if (composer.offsetParent !== null) return composer
    }
    return null
  }

  private lift(): void {
    const height = `${this.lifted?.offsetHeight ?? 0}px`
    if (document.documentElement.style.getPropertyValue('--games-lift') !== height) {
      document.documentElement.style.setProperty('--games-lift', height)
    }
  }

  /** shows the window with its game and gives it the keyboard; also how a folded window unfolds */
  private open(): void {
    this.phase = 'open'
    this.draw()
    this.win.focus()
    this.cb.changed()
  }

  /** folds or closes the window: the game pauses and the save is written now; the keyboard goes to the tab if it was here */
  private hide(next: 'closed' | 'folded'): void {
    const hadFocus = this.win.contains(document.activeElement)
    this.phase = next
    this.setPaused(true)
    this.closeMenu()
    this.saveNow()
    this.draw()
    if (hadFocus) this.cb.focusTab()
    this.cb.changed()
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const route = gameKeyRoute(e, this.platform, this.isPaused())
    // an app shortcut runs in the document's handler, which sees this key too; the macOS menu takes its own ⌘ chords
    if (route === 'pass') return
    e.preventDefault()
    if (route === 'drop') return
    if (route === 'tab') {
      this.closeMenu()
      this.cb.focusTab()
      return
    }
    if (route === 'resume') {
      this.setPaused(false)
      this.draw()
      return
    }
    this.current?.key(e.code, down)
  }

  private togglePause(): void {
    if (this.current === null || !this.current.pausable) return
    this.setPaused(!this.isPaused())
    this.draw()
  }

  private isPaused(): boolean {
    return this.current !== null && this.paused.get(this.current.id) === true
  }

  /** the game in front is paused or not; Runner stops when the keyboard leaves it, and when the app loses focus */
  private setPaused(paused: boolean): void {
    if (this.current !== null) this.setPausedOf(this.current, paused)
  }

  /** a game with nothing to pause (not pausable, or Runner outside a run) is never paused */
  private setPausedOf(view: GameView, paused: boolean): void {
    this.paused.set(view.id, paused && view.canPause())
  }

  private pauseOnLeave(): void {
    if (this.current?.realtime) this.setPaused(true)
  }

  private openMenu(): void {
    // the rows are built when the menu opens, so each shows its game's note as it is now
    this.menu.replaceChildren(...this.views.map((v) => {
      const item = el('button', 'games-menu-item')
      item.dataset.game = v.id
      item.classList.toggle('active', v === this.current)
      item.append(el('span', 'games-menu-title', v.title), el('span', 'games-menu-note', v.menuNote()))
      item.addEventListener('click', () => this.pick(v))
      return item
    }))
    this.menu.hidden = false
  }

  private closeMenu(): void {
    this.menu.hidden = true
  }

  /** the game in the menu: the game in front pauses and is written now; the new one takes the window and the keyboard */
  private pick(view: GameView): void {
    this.closeMenu()
    if (view !== this.current) {
      // the game in front pauses when it is left; the one picked comes back as it was
      if (this.current !== null) this.setPausedOf(this.current, true)
      this.current = view
      this.saveNow()
      this.draw()
    }
    this.win.focus()
  }

  private changed(): void {
    if (this.saveTimer !== null) return
    this.saveTimer = window.setTimeout(() => this.saveNow(), SAVE_DELAY_MS)
  }

  private saveNow(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.save === null) return
    const save: GamesSave = { ...this.save, game: this.current?.id ?? this.save.game }
    for (const v of this.views) v.saveInto(save)
    this.save = save
    this.cb.save(save)
  }

  /** the window, the pill, the game's place and its keys' state are drawn from the state; each view is told whether it is shown and live */
  private draw(): void {
    const view = this.current
    if (view === null) return
    const paused = this.isPaused()
    this.win.hidden = this.phase !== 'open'
    this.pill.hidden = this.phase !== 'folded'
    this.win.dataset.game = view.id
    this.win.dataset.keyboard = this.keyboard
    this.win.dataset.paused = String(paused)
    this.title.textContent = view.title
    if (this.slot.firstChild !== view.el) this.slot.replaceChildren(view.el)
    this.pauseButton.disabled = !view.pausable
    this.pauseButton.textContent = paused ? '▶' : '⏸'
    this.pauseButton.title = paused ? 'Resume' : 'Pause'
    this.overlay.hidden = !paused
    this.pill.innerHTML = icon('gamepad', 14)
    this.pill.append(el('span', 'games-pill-title', view.title))
    if (paused) this.pill.append(el('span', 'games-pill-state', 'paused'))
    this.pill.append(el('span', 'games-pill-caret', '▴'))
    // a view is shown only while the app has the focus: the Clicker keeps counting, so it stops when the app is in the background
    for (const v of this.views) {
      const shown = v === view && this.phase === 'open' && this.appFocused
      v.setState(shown, shown && !paused && this.keyboard === 'game')
    }
  }
}
