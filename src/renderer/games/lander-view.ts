import type { GamesSave } from '../../shared/games'
import { CLAWD, paintSprite } from './clawd'
import { FrameLoop } from './frame-loop'
import type { GameView } from './game-view'
import { LANDER, newRun, start, step, type LanderState } from './lander-rules'
import { newSeed, seeded } from './random'

const MONO = 'ui-monospace, Consolas, monospace'

const fmt = (n: number): string => n.toLocaleString('en-US')

/** the keys of the game: thrust, and the two turns */
const GAME_KEYS: readonly string[] = ['ArrowUp', 'Space', 'ArrowLeft', 'ArrowRight']

/** 24 fixed stars in the upper half of the field, the same on every run */
const starRand = seeded(7)
const STARS = Array.from({ length: 24 }, () => ({
  x: Math.floor(starRand.next() * LANDER.width),
  y: Math.floor(starRand.next() * (LANDER.height / 2))
}))

/** a filled triangle through three points */
function triangle(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): void {
  ctx.beginPath()
  ctx.moveTo(ax, ay)
  ctx.lineTo(bx, by)
  ctx.lineTo(cx, cy)
  ctx.closePath()
  ctx.fill()
}

/** Lander: Clawd thrusts and turns a craft down onto the pad; a soft landing scores and the next level is harder, a hard touch crashes */
export class LanderView implements GameView {
  readonly id = 'lander' as const
  readonly title = 'Lander'
  readonly el = document.createElement('div')
  readonly pausable = true
  readonly realtime = true
  private state: LanderState
  private best: number
  /** shown, not paused, and the game has the keyboard */
  private live = false
  /** the game's keys held down: thrust and the turns */
  private readonly held = new Set<string>()
  /** counts every paint: the flame flickers by it */
  private paints = 0
  private readonly loop = new FrameLoop((dt) => this.advance(dt))
  private readonly scoreText = document.createElement('span')
  private readonly bestText = document.createElement('span')
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly hud: Record<'vx' | 'vy' | 'angle' | 'fuel' | 'level' | 'wind', HTMLSpanElement>
  /** the theme's colors, read once */
  private readonly colors: Record<'accent' | 'text' | 'text3' | 'text4' | 'line3' | 'raised' | 'raised2' | 'green' | 'red' | 'amber', string>

  constructor(
    best: number,
    private readonly changed: () => void,
    seed: () => number = newSeed,
    run: (seed: number) => LanderState = newRun
  ) {
    this.best = best
    this.state = run(seed())
    this.el.className = 'lander'

    const head = document.createElement('div')
    head.className = 'lander-head'
    this.scoreText.className = 'lander-score'
    this.bestText.className = 'lander-best'
    head.append(this.scoreText, this.bestText)

    const dpr = window.devicePixelRatio || 1
    this.canvas.className = 'lander-canvas'
    this.canvas.width = LANDER.width * dpr
    this.canvas.height = LANDER.height * dpr
    this.ctx = this.canvas.getContext('2d')!
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const style = getComputedStyle(document.documentElement)
    const color = (name: string): string => style.getPropertyValue(name).trim()
    this.colors = {
      accent: color('--accent'),
      text: color('--text'),
      text3: color('--text-3'),
      text4: color('--text-4'),
      line3: color('--line-3'),
      raised: color('--raised'),
      raised2: color('--raised-2'),
      green: color('--green'),
      red: color('--red'),
      amber: color('--amber')
    }

    const hud = document.createElement('div')
    hud.className = 'lander-hud'
    this.hud = {
      vx: this.span('lander-vx'),
      vy: this.span('lander-vy'),
      angle: this.span('lander-angle'),
      fuel: this.span('lander-fuel'),
      level: this.span('lander-level'),
      wind: this.span('lander-wind')
    }
    hud.append(this.hud.vx, this.hud.vy, this.hud.angle, this.hud.fuel, this.hud.level, this.hud.wind)

    const hint = document.createElement('div')
    hint.className = 'lander-hint'
    hint.textContent = '↑/Space thrust · ←/→ turn'

    this.el.append(head, this.canvas, hud, hint)
    this.paint()
  }

  /** a run in play is paused; before a run and after a crash there is nothing to stop */
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
    const thrustKey = code === 'ArrowUp' || code === 'Space'
    if ((this.state.phase === 'ready' && thrustKey) || (this.state.phase === 'crashed' && code === 'Space')) {
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
    }
    this.paint()
  }

  saveInto(save: GamesSave): void {
    save.landerBest = this.best
  }

  menuNote(): string {
    return `best ${fmt(this.best)}`
  }

  private span(cls: string): HTMLSpanElement {
    const s = document.createElement('span')
    s.className = cls
    return s
  }

  private inPlay(): boolean {
    return this.state.phase === 'flying' || this.state.phase === 'landed'
  }

  /** one frame of the loop: the held keys are the input; the loop goes on while the game is live and in play */
  private advance(dt: number): boolean {
    const input = {
      thrust: this.held.has('ArrowUp') || this.held.has('Space'),
      left: this.held.has('ArrowLeft'),
      right: this.held.has('ArrowRight')
    }
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
    this.paints++
    this.el.dataset.phase = s.phase
    this.el.dataset.level = String(s.level)
    this.el.dataset.fuel = String(Math.round(s.fuel))
    this.el.dataset.vx = String(Math.round(s.vx))
    this.el.dataset.vy = String(Math.round(s.vy))
    this.el.dataset.angle = String(Math.round(s.angle))
    this.scoreText.textContent = `score ${fmt(s.score)}`
    this.bestText.textContent = `best ${fmt(this.best)}`
    this.paintHud(s)
    this.drawField(s)
  }

  private paintHud(s: LanderState): void {
    const h = this.hud
    h.vx.textContent = `${s.vx >= 0 ? '→' : '←'} ${Math.round(Math.abs(s.vx))}`
    h.vx.classList.toggle('bad', Math.abs(s.vx) > LANDER.safeVx)
    h.vy.textContent = `${s.vy >= 0 ? '↓' : '↑'} ${Math.round(Math.abs(s.vy))}`
    h.vy.classList.toggle('bad', Math.abs(s.vy) > LANDER.safeVy)
    h.angle.textContent = `∠ ${Math.round(Math.abs(s.angle))}°`
    h.angle.classList.toggle('bad', Math.abs(s.angle) > LANDER.safeAngle)
    h.fuel.textContent = `fuel ${Math.round(s.fuel)}`
    h.fuel.classList.toggle('bad', s.fuel < 15)
    h.level.textContent = `L${s.level}`
    h.wind.textContent = `wind ${s.wind >= 0 ? '→' : '←'} ${Math.abs(s.wind).toFixed(1)}`
    h.wind.hidden = s.wind === 0
  }

  private drawField(s: LanderState): void {
    const ctx = this.ctx
    const c = this.colors
    const { width, height, footX, footY } = LANDER
    ctx.clearRect(0, 0, width, height)

    ctx.fillStyle = c.text4
    for (const star of STARS) ctx.fillRect(star.x, star.y, 1, 1)

    const pts = s.terrain.points
    ctx.beginPath()
    ctx.moveTo(0, height)
    for (const p of pts) ctx.lineTo(p.x, p.y)
    ctx.lineTo(width, height)
    ctx.closePath()
    ctx.fillStyle = c.raised2
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (const p of pts) ctx.lineTo(p.x, p.y)
    ctx.strokeStyle = c.line3
    ctx.lineWidth = 1
    ctx.stroke()

    const t = s.terrain
    ctx.fillStyle = c.green
    ctx.fillRect(t.padX0, t.padY - 1, t.padX1 - t.padX0, 2)
    ctx.font = `11px ${MONO}`
    ctx.fillStyle = c.text3
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    ctx.fillText('[', t.padX0 - 1, t.padY)
    ctx.textAlign = 'left'
    ctx.fillText(']', t.padX1 + 1, t.padY)

    // the craft can fly above the top of the field: a marker shows where it is
    if (s.y < 0) {
      ctx.textAlign = 'center'
      ctx.fillText('^', s.x, 8)
    }

    const crashed = s.phase === 'crashed'
    ctx.save()
    ctx.translate(s.x, s.y)
    ctx.rotate((s.angle * Math.PI) / 180)
    if (s.thrusting) {
      const len = 8 + 2 * (this.paints % 3)
      ctx.fillStyle = c.amber
      triangle(ctx, -4, 5, 4, 5, 0, 5 + len)
      ctx.fillStyle = c.accent
      triangle(ctx, -2, 5, 2, 5, 0, 5 + 0.6 * len)
    }
    ctx.strokeStyle = c.text3
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(-7, 4)
    ctx.lineTo(-footX, footY)
    ctx.moveTo(7, 4)
    ctx.lineTo(footX, footY)
    ctx.stroke()
    ctx.fillStyle = c.text3
    ctx.fillRect(-footX - 3, footY - 2, 6, 2)
    ctx.fillRect(footX - 3, footY - 2, 6, 2)
    ctx.beginPath()
    ctx.roundRect(-11, -12, 22, 14, 5)
    ctx.fillStyle = c.raised
    ctx.fill()
    ctx.strokeStyle = crashed ? c.red : c.text3
    ctx.lineWidth = 1
    ctx.stroke()
    paintSprite(ctx, CLAWD, -9, -11, 1, crashed ? c.red : c.accent)
    ctx.fillStyle = c.text3
    ctx.fillRect(-12, 2, 24, 3)
    ctx.restore()

    if (s.phase !== 'flying') {
      const text = s.phase === 'ready' ? 'Space or ↑ to start' : s.phase === 'landed' ? `Landed · +${s.gained}` : 'Crashed · Space to fly again'
      ctx.fillStyle = c.text
      ctx.font = `13px ${MONO}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, width / 2, 70)
    }
  }
}
