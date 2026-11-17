import type { GamesSave } from '../../shared/games'
import { BUG, paintPixels } from './bug'
import { FrameLoop } from './frame-loop'
import type { GameView } from './game-view'
import { flipperTip, newGame, PINBALL, start, step, TABLE, type PinballInput, type PinballState } from './pinball-rules'

const MONO = 'ui-monospace, Consolas, monospace'

const fmt = (n: number): string => n.toLocaleString('en-US')

/** the keys of the game: the two flippers, and the plunger */
const GAME_KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'Space']

/** Pinball: Clawd pulls the plunger, launches the ball and works the two flippers; bumpers, targets and the lane score */
export class PinballView implements GameView {
  readonly id = 'pinball' as const
  readonly title = 'Pinball'
  readonly el = document.createElement('div')
  readonly pausable = true
  readonly realtime = true
  private state: PinballState
  private best: number
  /** shown, not paused, and the game has the keyboard */
  private live = false
  /** the game's keys held down */
  private readonly held = new Set<string>()
  /** the game's keys pressed since the last frame, so that a tap shorter than a frame still acts */
  private readonly pressed = new Set<string>()
  private readonly loop = new FrameLoop((dt) => this.advance(dt))
  private readonly scoreText = document.createElement('span')
  private readonly bestText = document.createElement('span')
  private readonly ballsText = document.createElement('span')
  private readonly powerFill = document.createElement('div')
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  /** the theme's colors, read once */
  private readonly colors: Record<'accent' | 'text' | 'text3' | 'line3' | 'raised' | 'raised2' | 'field' | 'green' | 'red' | 'amber', string>

  constructor(best: number, private readonly changed: () => void) {
    this.best = best
    this.state = newGame()
    this.el.className = 'pinball'

    const dpr = window.devicePixelRatio || 1
    this.canvas.className = 'pinball-canvas'
    this.canvas.width = PINBALL.width * dpr
    this.canvas.height = PINBALL.height * dpr
    this.ctx = this.canvas.getContext('2d')!
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const style = getComputedStyle(document.documentElement)
    const color = (name: string): string => style.getPropertyValue(name).trim()
    this.colors = {
      accent: color('--accent'),
      text: color('--text'),
      text3: color('--text-3'),
      line3: color('--line-3'),
      raised: color('--raised'),
      raised2: color('--raised-2'),
      field: color('--field'),
      green: color('--green'),
      red: color('--red'),
      amber: color('--amber')
    }

    this.scoreText.className = 'pinball-score'
    this.bestText.className = 'pinball-best'
    this.ballsText.className = 'pinball-balls'
    const bar = document.createElement('div')
    bar.className = 'pinball-power'
    this.powerFill.className = 'pinball-power-fill'
    bar.append(this.powerFill)

    const main = document.createElement('div')
    main.className = 'pinball-main'
    const side = document.createElement('div')
    side.className = 'pinball-side'
    side.append(
      this.stat('score', this.scoreText),
      this.stat('best', this.bestText),
      this.stat('balls', this.ballsText),
      this.stat('power', bar)
    )
    main.append(this.canvas, side)

    const hint = document.createElement('div')
    hint.className = 'pinball-hint'
    hint.textContent = '←/→ flippers · Space launch'

    this.el.append(main, hint)
    this.paint()
  }

  /** a game in play is paused; before a game and after the last ball there is nothing to stop */
  canPause(): boolean {
    return this.inPlay()
  }

  key(code: string, down: boolean): boolean {
    if (!GAME_KEYS.includes(code)) return false
    if (!down) {
      this.held.delete(code)
      return true
    }
    if (!this.live) return true
    this.held.add(code)
    this.pressed.add(code)
    if (code === 'Space' && (this.state.phase === 'ready' || this.state.phase === 'over')) {
      this.state = start(this.state)
      this.loop.start()
    }
    this.paint()
    return true
  }

  setState(shown: boolean, live: boolean): void {
    this.live = shown && live
    if (this.live && this.inPlay()) {
      this.loop.start()
    } else {
      this.loop.stop()
      this.held.clear()
      this.pressed.clear()
      // a pull stopped by a pause lets the plunger back: the resume does not launch
      if (this.state.onPlunger && this.state.power > 0) this.state = { ...this.state, power: 0 }
    }
    this.paint()
  }

  saveInto(save: GamesSave): void {
    save.pinballBest = this.best
  }

  menuNote(): string {
    return `best ${fmt(this.best)}`
  }

  private stat(label: string, value: HTMLElement): HTMLElement {
    const block = document.createElement('div')
    block.className = 'pinball-stat'
    const name = document.createElement('div')
    name.className = 'pinball-label'
    name.textContent = label
    block.append(name, value)
    return block
  }

  private inPlay(): boolean {
    return this.state.phase === 'play'
  }

  /** one frame of the loop: the held and pressed keys are the input; the loop goes on while the game is live and in play */
  private advance(dt: number): boolean {
    const down = (code: string): boolean => this.held.has(code) || this.pressed.has(code)
    const input: PinballInput = { left: down('ArrowLeft'), right: down('ArrowRight'), plunger: down('Space') }
    this.pressed.clear()
    const next = step(this.state, input, dt)
    this.state = next
    if (next.score > this.best) {
      this.best = next.score
      this.changed()
    }
    this.paint()
    return this.live && this.inPlay()
  }

  private paint(): void {
    const s = this.state
    this.el.dataset.phase = s.phase
    this.el.dataset.score = String(s.score)
    this.el.dataset.balls = String(s.balls)
    this.el.dataset.ball = s.onPlunger ? 'plunger' : 'loose'
    this.el.dataset.ballX = String(Math.round(s.ball.x))
    this.el.dataset.ballY = String(Math.round(s.ball.y))
    this.el.dataset.power = String(Math.round(s.power * 100))
    this.scoreText.textContent = fmt(s.score)
    this.bestText.textContent = fmt(this.best)
    // a ball left is ●, a ball lost is ○
    this.ballsText.textContent = Array.from({ length: PINBALL.balls }, (_, i) => (i < s.balls ? '●' : '○')).join(' ')
    this.powerFill.style.width = `${s.power * 100}%`
    this.drawTable(s)
  }

  private drawTable(s: PinballState): void {
    const ctx = this.ctx
    const c = this.colors
    const { width, height, ballR, flipperR } = PINBALL
    ctx.clearRect(0, 0, width, height)

    ctx.fillStyle = c.field
    ctx.fillRect(0, 0, width, height)

    // the walls, all of them in one stroke
    ctx.beginPath()
    for (const w of TABLE.walls) {
      ctx.moveTo(w.x1, w.y1)
      ctx.lineTo(w.x2, w.y2)
    }
    ctx.strokeStyle = c.line3
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.stroke()

    // the two bracket targets: a 3 px line each, and the bracket on the wall beside it
    ctx.font = `16px ${MONO}`
    ctx.textBaseline = 'middle'
    TABLE.targets.forEach((t, i) => {
      const lit = s.lit[i]
      ctx.beginPath()
      ctx.moveTo(t.x1, t.y1)
      ctx.lineTo(t.x2, t.y2)
      ctx.strokeStyle = lit ? c.amber : c.line3
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.fillStyle = s.flash.targets[i] > 0 ? c.text : lit ? c.amber : c.text3
      ctx.textAlign = i === 0 ? 'left' : 'right'
      ctx.fillText(i === 0 ? '{' : '}', i === 0 ? 13 : 163, 134)
    })

    ctx.fillStyle = c.line3
    for (const p of TABLE.posts) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }

    // the lane's `>_`, lit while the ball has just passed into it
    ctx.font = `11px ${MONO}`
    ctx.fillStyle = s.flash.lane > 0 ? c.green : c.text3
    ctx.textAlign = 'center'
    ctx.fillText('>_', TABLE.lane.x0 + (TABLE.lane.x1 - TABLE.lane.x0) / 2, 36)

    // a bumper lit red while it flashes, its bug then goes dark; at rest a red bug sits on a raised disc
    TABLE.bumpers.forEach((b, i) => {
      const flashing = s.flash.bumpers[i] > 0
      ctx.beginPath()
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
      ctx.fillStyle = flashing ? c.red : c.raised2
      ctx.fill()
      ctx.strokeStyle = c.red
      ctx.lineWidth = 2
      ctx.stroke()
      paintPixels(ctx, BUG, b.x - 7, b.y - 5, flashing ? c.raised : c.red)
    })

    ctx.strokeStyle = c.accent
    ctx.lineWidth = 2 * flipperR
    ctx.lineCap = 'round'
    TABLE.flippers.forEach((spec, i) => {
      const tip = flipperTip(i as 0 | 1, s.flippers[i].angle)
      ctx.beginPath()
      ctx.moveTo(spec.x, spec.y)
      ctx.lineTo(tip.x, tip.y)
      ctx.stroke()
    })

    // the plunger's head sinks as the plunger is pulled, and the ball sits on it
    ctx.fillStyle = c.text3
    ctx.fillRect(172, 246 + 3 * s.power, 10, 2)
    const sink = s.onPlunger ? 3 * s.power : 0
    ctx.fillStyle = c.text
    ctx.beginPath()
    ctx.arc(s.ball.x, s.ball.y + sink, ballR, 0, Math.PI * 2)
    ctx.fill()

    ctx.font = `13px ${MONO}`
    ctx.fillStyle = c.text
    ctx.textAlign = 'center'
    if (s.phase === 'ready') ctx.fillText('Space to launch', 88, 165)
    if (s.phase === 'over') {
      ctx.fillText('Game over', 88, 165)
      ctx.fillText('Space to play again', 88, 181)
    }
  }
}
