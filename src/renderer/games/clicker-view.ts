import type { ClickerSave, GamesSave } from '../../shared/games'
import { CLAWD, paintSprite } from './clawd'
import { AWAY_NOTE_MS, buy, catchUp, click, HELPERS, newClicker, price, rate, shortNumber } from './clicker-rules'
import type { GameView } from './game-view'

/** Clawd is drawn at this many CSS px per pixel of the sprite */
const CLAWD_UNIT = 6

/** the count and the rates are brought up to date and drawn this often, while the view is shown */
const TICK_MS = 250

/** how long the "+1" a click leaves above Clawd stays up */
const FLOAT_MS = 600

/**
 * Clicker: a click on Clawd writes a line, and the helpers write lines by themselves. The lines are worked out from the
 * time since the last update, so nothing runs while the view is hidden: it is brought up to date when it is shown.
 */
export class ClickerView implements GameView {
  readonly id = 'clicker' as const
  readonly title = 'Clicker'
  readonly el = document.createElement('div')
  readonly pausable = false
  readonly realtime = false
  private save: ClickerSave
  /** the lines an absence earned, shown until the next click or purchase; null when there is no note to show */
  private awayEarned: number | null = null
  /** the interval that keeps the view current; null while the view is hidden */
  private timer: number | null = null
  /** the time and the lines counted while the view is hidden, since it was last shown: the absence the note tells of */
  private hiddenAway = 0
  private hiddenEarned = 0
  private readonly count = document.createElement('span')
  private readonly rateText = document.createElement('span')
  private readonly away = document.createElement('div')
  private readonly clawd = document.createElement('button')
  private readonly buys: { button: HTMLButtonElement; owned: HTMLElement; cost: HTMLElement }[] = []

  constructor(save: ClickerSave | null, private readonly changed: () => void, private readonly now: () => number = () => Date.now()) {
    this.save = save ?? newClicker(now())
    this.el.className = 'clicker'

    const head = document.createElement('div')
    head.className = 'clicker-head'
    this.count.className = 'clicker-count'
    const label = document.createElement('span')
    label.className = 'clicker-label'
    label.textContent = 'lines'
    this.rateText.className = 'clicker-rate'
    head.append(this.count, label, this.rateText)

    this.away.className = 'clicker-away'
    this.away.hidden = true

    const dpr = window.devicePixelRatio || 1
    const canvas = document.createElement('canvas')
    canvas.width = CLAWD[0].length * CLAWD_UNIT * dpr
    canvas.height = CLAWD.length * 2 * CLAWD_UNIT * dpr
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    paintSprite(ctx, CLAWD, 0, 0, CLAWD_UNIT, color)
    this.clawd.className = 'clicker-clawd'
    this.clawd.append(canvas)
    this.clawd.addEventListener('click', () => this.clickClawd())

    const helpers = document.createElement('div')
    helpers.className = 'clicker-helpers'
    HELPERS.forEach((helper, i) => {
      const button = document.createElement('button')
      button.className = 'clicker-buy'
      button.dataset.helper = String(i)
      const name = document.createElement('span')
      name.className = 'clicker-buy-name'
      name.textContent = helper.name
      const owned = document.createElement('span')
      owned.className = 'clicker-buy-owned'
      const cost = document.createElement('span')
      cost.className = 'clicker-buy-price'
      button.append(name, owned, cost)
      button.addEventListener('click', () => this.purchase(i))
      this.buys.push({ button, owned, cost })
      helpers.append(button)
    })

    const hint = document.createElement('div')
    hint.className = 'clicker-hint'
    hint.textContent = 'Click Clawd to write a line'

    this.el.append(head, this.away, this.clawd, helpers, hint)
    this.paint()
  }

  /** the Clicker keeps its count while it is shown: the window never pauses it */
  canPause(): boolean {
    return false
  }

  key(): boolean {
    return false
  }

  /** shown: catches up with the time away and keeps the view current; hidden: stops the interval */
  setState(shown: boolean): void {
    if (!shown) {
      this.stop()
      return
    }
    // the window draws again on every change; only the first show starts the interval and counts the absence
    if (this.timer !== null) return
    this.sync()
    this.awayEarned = this.hiddenAway >= AWAY_NOTE_MS && this.hiddenEarned > 0 ? this.hiddenEarned : null
    this.hiddenAway = 0
    this.hiddenEarned = 0
    this.timer = window.setInterval(() => this.tick(), TICK_MS)
    this.paint()
  }

  saveInto(save: GamesSave): void {
    this.sync()
    save.clicker = { ...this.save, helpers: this.save.helpers.slice() }
  }

  menuNote(): string {
    this.sync()
    return `${shortNumber(this.save.lines)} lines`
  }

  /** brings the lines up to the present; the save is then current, so its `at` is now. While hidden, the time and lines are added to the absence */
  private sync(): { earned: number; away: number } {
    const result = catchUp(this.save, this.now())
    this.save = result.save
    if (this.timer === null) {
      this.hiddenAway += result.away
      this.hiddenEarned += result.earned
    }
    return result
  }

  private stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    this.sync()
    this.paint()
  }

  private clickClawd(): void {
    this.sync()
    this.save = click(this.save)
    this.awayEarned = null
    this.floatPlus()
    this.paint()
    this.changed()
  }

  /** buys one helper of this kind when the lines are enough for it, after catching up, so the price is the true one */
  private purchase(helper: number): void {
    this.sync()
    const next = buy(this.save, helper)
    if (next === null) return
    this.save = next
    this.awayEarned = null
    this.paint()
    this.changed()
  }

  private floatPlus(): void {
    const plus = document.createElement('span')
    plus.className = 'clicker-float'
    plus.textContent = '+1'
    this.clawd.append(plus)
    window.setTimeout(() => plus.remove(), FLOAT_MS)
  }

  private paint(): void {
    const s = this.save
    this.count.textContent = shortNumber(s.lines)
    this.rateText.textContent = `+${shortNumber(rate(s))} per second`
    const away = this.awayEarned
    this.away.hidden = away === null
    if (away !== null) this.away.textContent = `+${shortNumber(away)} lines while you were away`
    this.buys.forEach((row, i) => {
      const cost = price(s, i)
      row.owned.textContent = `${s.helpers[i]} owned`
      row.cost.textContent = shortNumber(cost)
      row.button.disabled = s.lines < cost
    })
  }
}
