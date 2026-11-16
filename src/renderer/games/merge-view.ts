import type { GamesSave, MergeSave } from '../../shared/games'
import type { GameView } from './game-view'
import { canMove, GOAL, move, newMerge, tileLabel, type Dir, type TilePath } from './merge-rules'

/** how long the tiles slide, and how long a merged or new tile pops */
const SLIDE_MS = 110
const POP_MS = 140

/** the arrow keys and the way each one slides the tiles */
const ARROW_DIRS: Partial<Record<string, Dir>> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

const fmt = (n: number): string => n.toLocaleString('en-US')

/** Merge: the arrows slide the tiles, equal neighbours merge, and the goal is a 1 MB tile */
export class MergeView implements GameView {
  readonly id = 'merge' as const
  readonly title = 'Merge'
  readonly el = document.createElement('div')
  readonly pausable = true
  private save: MergeSave
  /** shown, not paused, and the game has the keyboard */
  private live = false
  /** the move that made the goal tile is played and its note is up, until Keep going */
  private celebrating = false
  private readonly score = document.createElement('span')
  private readonly best = document.createElement('span')
  private readonly board = document.createElement('div')
  private readonly cells: HTMLElement[] = []
  /** the ghosts of the move that is sliding, and the timer that ends it */
  private ghosts: HTMLElement[] = []
  private slideTimer: ReturnType<typeof setTimeout> | null = null
  private readonly goalNote = document.createElement('div')
  private readonly stuckNote = document.createElement('div')

  constructor(save: MergeSave | null, private readonly changed: () => void, private readonly rand: () => number = Math.random) {
    this.save = save ?? newMerge(rand)
    this.el.className = 'merge'

    const head = document.createElement('div')
    head.className = 'merge-head'
    this.score.className = 'merge-score'
    this.best.className = 'merge-best'
    const newGame = document.createElement('button')
    newGame.className = 'merge-new'
    newGame.textContent = 'New game'
    newGame.addEventListener('click', () => this.newGame())
    head.append(this.score, this.best, newGame)

    this.board.className = 'merge-board'
    for (let i = 0; i < this.save.board.length; i++) {
      const cell = document.createElement('div')
      cell.className = 'merge-cell'
      this.cells.push(cell)
      this.board.append(cell)
    }

    this.goalNote.className = 'merge-note merge-goal'
    const goalText = document.createElement('span')
    goalText.textContent = `${tileLabel(GOAL)}!`
    const keepGoing = document.createElement('button')
    keepGoing.className = 'merge-keep'
    keepGoing.textContent = 'Keep going'
    keepGoing.addEventListener('click', () => this.keepGoing())
    this.goalNote.append(goalText, keepGoing)

    this.stuckNote.className = 'merge-note merge-stuck'
    this.stuckNote.textContent = 'No moves'

    const hint = document.createElement('div')
    hint.className = 'merge-hint'
    hint.textContent = `Arrows to move · goal ${tileLabel(GOAL)}`

    this.el.append(head, this.board, this.goalNote, this.stuckNote, hint)
    this.draw()
  }

  canPause(): boolean {
    return true
  }

  key(code: string, down: boolean): boolean {
    const dir = ARROW_DIRS[code]
    if (dir === undefined) return false
    if (down && this.live) this.play(dir)
    return true
  }

  setState(shown: boolean, live: boolean): void {
    this.live = shown && live
  }

  saveInto(save: GamesSave): void {
    save.merge = { ...this.save, board: this.save.board.slice() }
  }

  menuNote(): string {
    return `best ${fmt(this.save.best)}`
  }

  private play(dir: Dir): void {
    this.settle()
    const before = this.save.board
    const r = move(this.save, dir, this.rand)
    if (!r.moved) return
    this.save = r.save
    if (r.reachedGoal) this.celebrating = true
    this.draw()
    this.animate(before, r.paths, r.merged, r.spawned)
    this.changed()
  }

  private canAnimate(): boolean {
    return typeof HTMLElement.prototype.animate === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /** ghosts slide over the cells (which already show the result, hidden where a tile arrives), then the merged and new tiles pop */
  private animate(before: number[], paths: TilePath[], merged: number[], spawned: number | null): void {
    if (!this.canAnimate()) return
    for (const { from, to } of paths) {
      const src = this.cells[from]
      const dst = this.cells[to]
      const ghost = document.createElement('div')
      ghost.className = 'merge-cell merge-ghost'
      ghost.dataset.e = String(before[from])
      ghost.textContent = tileLabel(before[from])
      ghost.style.left = `${src.offsetLeft}px`
      ghost.style.top = `${src.offsetTop}px`
      ghost.style.width = `${src.offsetWidth}px`
      ghost.style.height = `${src.offsetHeight}px`
      this.board.append(ghost)
      this.ghosts.push(ghost)
      dst.dataset.arriving = ''
      const dx = dst.offsetLeft - src.offsetLeft
      const dy = dst.offsetTop - src.offsetTop
      ghost.animate([{ transform: 'translate(0,0)' }, { transform: `translate(${dx}px,${dy}px)` }], { duration: SLIDE_MS, easing: 'ease-out', fill: 'forwards' })
    }
    if (spawned !== null) this.cells[spawned].dataset.arriving = ''
    this.slideTimer = setTimeout(() => {
      this.slideTimer = null
      this.clearGhosts()
      for (const i of merged) this.cells[i].animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: POP_MS })
      if (spawned !== null) {
        this.cells[spawned].animate([{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: POP_MS })
      }
    }, SLIDE_MS)
  }

  private clearGhosts(): void {
    for (const g of this.ghosts) g.remove()
    this.ghosts = []
    for (const c of this.cells) delete c.dataset.arriving
  }

  /** ends a running move at once: its timer, its animations, its ghosts */
  private settle(): void {
    if (this.slideTimer !== null) clearTimeout(this.slideTimer)
    this.slideTimer = null
    if (typeof this.board.getAnimations === 'function') {
      for (const a of this.board.getAnimations({ subtree: true })) a.cancel()
    }
    this.clearGhosts()
  }

  private newGame(): void {
    this.settle()
    this.save = newMerge(this.rand, this.save.best)
    this.celebrating = false
    this.draw()
    this.changed()
  }

  private keepGoing(): void {
    this.settle()
    this.celebrating = false
    this.draw()
  }

  private draw(): void {
    this.score.textContent = `score ${fmt(this.save.score)}`
    this.best.textContent = `best ${fmt(this.save.best)}`
    this.save.board.forEach((e, i) => {
      this.cells[i].dataset.e = String(e)
      this.cells[i].textContent = e === 0 ? '' : tileLabel(e)
    })
    this.board.dataset.cells = this.save.board.join(',')
    this.goalNote.hidden = !this.celebrating
    this.stuckNote.hidden = canMove(this.save.board)
  }
}
