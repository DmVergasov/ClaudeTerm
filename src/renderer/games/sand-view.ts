import type { GamesSave } from '../../shared/games'
import { FrameLoop } from './frame-loop'
import type { GameView } from './game-view'
import { newSeed } from './random'
import { colorOf, grain, newGame, pieceCells, SAND, start, step, type SandInput, type SandState } from './sand-rules'

const MONO = 'ui-monospace, Consolas, monospace'

const fmt = (n: number): string => n.toLocaleString('en-US')

/** the keys of the game: the two sides, the turn, the faster fall, and the drop */
const GAME_KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Space']

/** a grain's side on the canvas, in px: the board is 42 × 60 grains */
const GRAIN_PX = 4

/** the shade factors of a colour: the four shades of a grain colour are this much lighter or darker */
const SHADE_FACTOR = [1, 0.9, 0.8, 1.1]

/** a colour `#rrggbb` times a factor, clamped to 255; any other colour is used as it is */
function shaded(hex: string, factor: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (m === null) return hex
  const n = parseInt(m[1], 16)
  const channel = (shift: number): number => Math.min(255, Math.round(((n >> shift) & 255) * factor))
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`
}

/** Sand: pieces fall into a well, their grains pile up, and a one-colour band that touches both walls clears */
export class SandView implements GameView {
  readonly id = 'sand' as const
  readonly title = 'Sand'
  readonly el = document.createElement('div')
  readonly pausable = true
  readonly realtime = true
  private state: SandState
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
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly nextCanvas = document.createElement('canvas')
  private readonly nextCtx: CanvasRenderingContext2D
  /** the theme's colors, read once */
  private readonly colors: Record<'well' | 'line2' | 'raised' | 'text', string>
  /** the fill of each grain value 1 to 16 (index 0 is unused): its colour and shade */
  private readonly fills: string[] = ['']

  constructor(
    best: number,
    private readonly changed: () => void,
    seed: () => number = newSeed,
    game: (seed: number) => SandState = newGame
  ) {
    this.best = best
    this.state = game(seed())
    this.el.className = 'sand'

    const dpr = window.devicePixelRatio || 1
    this.canvas.className = 'sand-canvas'
    this.canvas.width = SAND.width * GRAIN_PX * dpr
    this.canvas.height = SAND.height * GRAIN_PX * dpr
    this.ctx = this.canvas.getContext('2d')!
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    this.nextCanvas.className = 'sand-next'
    this.nextCanvas.width = 48 * dpr
    this.nextCanvas.height = 48 * dpr
    this.nextCtx = this.nextCanvas.getContext('2d')!
    this.nextCtx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const style = getComputedStyle(document.documentElement)
    const color = (name: string): string => style.getPropertyValue(name).trim()
    this.colors = { well: color('--well'), line2: color('--line-2'), raised: color('--raised'), text: color('--text') }
    const palette = [color('--accent'), color('--blue'), color('--green'), color('--amber')]
    for (let v = 1; v <= SAND.colors * SAND.shades; v++) {
      this.fills.push(shaded(palette[colorOf(v)], SHADE_FACTOR[(v - 1) % SAND.shades]))
    }

    this.scoreText.className = 'sand-score'
    this.bestText.className = 'sand-best'
    const main = document.createElement('div')
    main.className = 'sand-main'
    const side = document.createElement('div')
    side.className = 'sand-side'
    side.append(this.stat('next', this.nextCanvas), this.stat('score', this.scoreText), this.stat('best', this.bestText))
    main.append(this.canvas, side)

    const hint = document.createElement('div')
    hint.className = 'sand-hint'
    hint.textContent = '←/→ move · ↑ turn · ↓ faster · Space drop'

    this.el.append(main, hint)
    this.paint()
  }

  /** a game in play is paused; before a game and after the last one there is nothing to stop */
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
    if (code === 'Space' && !this.inPlay()) {
      // Space before a game or after one ends only starts it: it is not also a drop
      this.state = start(this.state)
      this.loop.start()
    } else if (this.inPlay()) {
      this.pressed.add(code)
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
    }
    this.paint()
  }

  saveInto(save: GamesSave): void {
    save.sandBest = this.best
  }

  menuNote(): string {
    return `best ${fmt(this.best)}`
  }

  private stat(label: string, value: HTMLElement): HTMLElement {
    const block = document.createElement('div')
    block.className = 'sand-stat'
    const name = document.createElement('div')
    name.className = 'sand-label'
    name.textContent = label
    block.append(name, value)
    return block
  }

  private inPlay(): boolean {
    return this.state.phase === 'playing'
  }

  /** one frame of the loop: the held keys and the presses since the last frame are the input; the loop goes on while the game is live and in play */
  private advance(dt: number): boolean {
    const input: SandInput = {
      left: this.held.has('ArrowLeft'),
      right: this.held.has('ArrowRight'),
      down: this.held.has('ArrowDown'),
      turn: this.pressed.has('ArrowUp'),
      drop: this.pressed.has('Space'),
      tapLeft: this.pressed.has('ArrowLeft'),
      tapRight: this.pressed.has('ArrowRight')
    }
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
    this.el.dataset.chain = String(s.chain)
    this.el.dataset.pieceX = s.piece === null ? '' : String(s.piece.x)
    this.el.dataset.pieceY = s.piece === null ? '' : String(s.piece.y)
    this.scoreText.textContent = fmt(s.score)
    this.bestText.textContent = fmt(this.best)
    this.drawBoard(s)
    this.drawNext(s)
  }

  private drawBoard(s: SandState): void {
    const ctx = this.ctx
    const width = SAND.width * GRAIN_PX
    const height = SAND.height * GRAIN_PX
    ctx.fillStyle = this.colors.well
    ctx.fillRect(0, 0, width, height)

    for (let i = 0; i < s.grid.length; i++) {
      const v = s.grid[i]
      if (v === 0) continue
      ctx.fillStyle = this.fills[v]
      ctx.fillRect((i % SAND.width) * GRAIN_PX, Math.floor(i / SAND.width) * GRAIN_PX, GRAIN_PX, GRAIN_PX)
    }

    // the grains of a clear flash fade out in white
    if (s.flash.left > 0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${(0.8 * s.flash.left) / SAND.flashFor})`
      for (const i of s.flash.cells) {
        ctx.fillRect((i % SAND.width) * GRAIN_PX, Math.floor(i / SAND.width) * GRAIN_PX, GRAIN_PX, GRAIN_PX)
      }
    }

    // the piece: each cell a block of k × k grains (12 px) in shade 0, with a 1 px inner outline in shade 2
    if (s.piece !== null) {
      const { piece } = s
      const cell = SAND.k * GRAIN_PX
      for (const [r, c] of pieceCells(piece)) {
        const x = (piece.x + c * SAND.k) * GRAIN_PX
        const y = (piece.y + r * SAND.k) * GRAIN_PX
        ctx.fillStyle = this.fills[grain(piece.color, 0)]
        ctx.fillRect(x, y, cell, cell)
        ctx.strokeStyle = this.fills[grain(piece.color, 2)]
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1)
      }
    }

    ctx.strokeStyle = this.colors.line2
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1)

    if (s.phase === 'ready' || s.phase === 'over') {
      ctx.fillStyle = this.colors.raised
      ctx.fillRect(0, height / 2 - 20, width, 40)
      ctx.font = `13px ${MONO}`
      ctx.fillStyle = this.colors.text
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      if (s.phase === 'ready') ctx.fillText('Space to start', width / 2, height / 2)
      else {
        ctx.fillText('Game over', width / 2, height / 2 - 8)
        ctx.fillText('Space to play again', width / 2, height / 2 + 8)
      }
    }
  }

  /** the next piece, centred in its box at 12 px a cell */
  private drawNext(s: SandState): void {
    const ctx = this.nextCtx
    ctx.clearRect(0, 0, 48, 48)
    const cells = pieceCells({ shape: s.next.shape, turn: 0 })
    const rows = cells.map(([r]) => r)
    const cols = cells.map(([, c]) => c)
    const cell = 12
    const w = (Math.max(...cols) - Math.min(...cols) + 1) * cell
    const h = (Math.max(...rows) - Math.min(...rows) + 1) * cell
    const x0 = (48 - w) / 2 - Math.min(...cols) * cell
    const y0 = (48 - h) / 2 - Math.min(...rows) * cell
    ctx.fillStyle = this.fills[grain(s.next.color, 0)]
    for (const [r, c] of cells) ctx.fillRect(x0 + c * cell, y0 + r * cell, cell, cell)
  }
}
