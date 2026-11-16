import type { GamesSave } from '../../shared/games'
import { CLAWD, CLAWD_DUCK, CLAWD_STEP, paintSprite } from './clawd'
import type { GameView } from './game-view'
import { hitBox, newRun, OBSTACLES, RUNNER, start, step, type ObstacleKind, type RunnerState } from './runner-rules'

/** the canvas is the field's width and this many CSS px tall; the ground line is GROUND_Y px down */
const CANVAS_H = 190
const GROUND_Y = 170

/** a frame of the bug: 7 × 5 cells, each cell 2 px */
const BUG: readonly string[] = ['#.###.#', '.#####.', '#######', '.#####.', '#.#.#.#']

/** what an obstacle shows: a bracket, braces or parens are monospace glyphs, a null is a label */
const LABELS: Partial<Record<ObstacleKind, { text: string; size: number }>> = {
  bracket: { text: '}', size: 22 },
  braces: { text: '{ }', size: 15 },
  parens: { text: '( )', size: 15 },
  null: { text: 'null', size: 11 }
}

const MONO = 'ui-monospace, Consolas, monospace'

const fmt = (n: number): string => n.toLocaleString('en-US')

/** Runner: Clawd runs along the ground and jumps or ducks over what comes; the run goes on until it hits something */
export class RunnerView implements GameView {
  readonly id = 'runner' as const
  readonly title = 'Runner'
  readonly el = document.createElement('div')
  readonly pausable = true
  private state: RunnerState = newRun()
  private best: number
  /** shown, not paused, and the game has the keyboard */
  private live = false
  /** a jump pressed since the last step: a key press is one jump */
  private jump = false
  /** ArrowDown is held */
  private duck = false
  /** the animation frame the loop waits for, and the time of the last frame it ran */
  private frameId: number | null = null
  private last: number | null = null
  private readonly scoreText = document.createElement('span')
  private readonly bestText = document.createElement('span')
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  /** the theme's colors, read once */
  private readonly colors: Record<'accent' | 'text' | 'text3' | 'line2' | 'red' | 'amber', string>

  constructor(best: number, private readonly changed: () => void, private readonly rand: () => number = Math.random) {
    this.best = best
    this.el.className = 'runner'

    const head = document.createElement('div')
    head.className = 'runner-head'
    this.scoreText.className = 'runner-score'
    this.bestText.className = 'runner-best'
    head.append(this.scoreText, this.bestText)

    const dpr = window.devicePixelRatio || 1
    this.canvas.className = 'runner-canvas'
    this.canvas.width = RUNNER.width * dpr
    this.canvas.height = CANVAS_H * dpr
    this.ctx = this.canvas.getContext('2d')!
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const style = getComputedStyle(document.documentElement)
    const color = (name: string): string => style.getPropertyValue(name).trim()
    this.colors = { accent: color('--accent'), text: color('--text'), text3: color('--text-3'), line2: color('--line-2'), red: color('--red'), amber: color('--amber') }

    const hint = document.createElement('div')
    hint.className = 'runner-hint'
    hint.textContent = 'Space/↑ jump · ↓ duck'

    this.el.append(head, this.canvas, hint)
    this.paint()
  }

  /** a run going is paused; before a run and after one there is nothing to stop */
  canPause(): boolean {
    return this.state.phase === 'running'
  }

  key(code: string, down: boolean): boolean {
    if (code === 'ArrowDown') {
      this.duck = down && this.live
      return true
    }
    if (code !== 'Space' && code !== 'ArrowUp') return false
    if (down && this.live) {
      if (this.state.phase === 'running') this.jump = true
      else {
        this.state = start(this.state)
        this.jump = false
        this.startLoop()
      }
      this.paint()
    }
    return true
  }

  setState(shown: boolean, live: boolean): void {
    this.live = shown && live
    if (this.live) {
      this.startLoop()
    } else {
      this.stopLoop()
      this.jump = false
      this.duck = false
    }
    this.paint()
  }

  saveInto(save: GamesSave): void {
    save.runnerBest = this.best
  }

  menuNote(): string {
    return `best ${fmt(this.best)}`
  }

  /** the loop runs only while the game is live and running; a run that stops keeps its state */
  private startLoop(): void {
    if (this.frameId !== null || !this.live || this.state.phase !== 'running') return
    this.frameId = requestAnimationFrame((now) => this.tick(now))
  }

  private stopLoop(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId)
    this.frameId = null
    this.last = null
  }

  private tick(now: number): void {
    this.frameId = null
    // the first frame of a loop only sets the clock, so a key pressed just before it is not lost in a zero step
    if (this.last !== null) this.advance((now - this.last) / 1000)
    this.last = now
    this.startLoop()
    // a loop that did not go on (the run ended) forgets its clock, so the next run's first frame does not step the time since
    if (this.frameId === null) this.last = null
  }

  private advance(dt: number): void {
    const next = step(this.state, { jump: this.jump, duck: this.duck }, dt, this.rand)
    this.jump = false
    this.state = next
    if (next.score > this.best) {
      this.best = next.score
      this.changed()
    }
    this.paint()
  }

  private paint(): void {
    const s = this.state
    this.el.dataset.phase = s.phase
    this.scoreText.textContent = `score ${fmt(s.score)}`
    this.bestText.textContent = `best ${fmt(this.best)}`
    this.drawField(s)
  }

  private drawField(s: RunnerState): void {
    const ctx = this.ctx
    const c = this.colors
    ctx.clearRect(0, 0, RUNNER.width, CANVAS_H)

    ctx.fillStyle = c.line2
    ctx.fillRect(0, GROUND_Y, RUNNER.width, 1)

    for (const o of s.obstacles) {
      const shape = OBSTACLES[o.kind]
      const top = GROUND_Y - shape.y - shape.h
      if (o.kind === 'bug') {
        paintPixels(ctx, BUG, o.x, top, c.red)
        continue
      }
      const label = LABELS[o.kind]!
      ctx.fillStyle = o.kind === 'null' ? c.amber : c.text3
      ctx.font = `${label.size}px ${MONO}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label.text, o.x + shape.w / 2, top + shape.h / 2)
    }

    const box = hitBox(s)
    const rows = s.ducking ? CLAWD_DUCK : s.y === 0 && Math.floor(s.frame / 6) % 2 === 1 ? CLAWD_STEP : CLAWD
    paintSprite(ctx, rows, box.x, GROUND_Y - box.y - box.h, 2, c.accent)

    if (s.phase !== 'running') {
      const text = s.phase === 'ready' ? 'Space to start' : 'Game over · Space to run again'
      ctx.fillStyle = c.text
      ctx.font = `13px ${MONO}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, RUNNER.width / 2, 80)
    }
  }
}

/** paints a pixel-art sprite whose cells are 2 px, with its top-left at (x, y) */
function paintPixels(ctx: CanvasRenderingContext2D, rows: readonly string[], x: number, y: number, color: string): void {
  ctx.fillStyle = color
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] === '#') ctx.fillRect(x + c * 2, y + r * 2, 2, 2)
    }
  })
}
