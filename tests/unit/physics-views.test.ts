import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANDER, newRun, type LanderState } from '../../src/renderer/games/lander-rules'
import { LanderView } from '../../src/renderer/games/lander-view'
import { PinballView } from '../../src/renderer/games/pinball-view'
import { grain, newGame, PIECES, SAND, spawn, type SandState } from '../../src/renderer/games/sand-rules'
import { SandView } from '../../src/renderer/games/sand-view'
import { EMPTY_GAMES } from '../../src/shared/games'

/** a canvas context that takes any drawing call and does nothing with it */
const ctx = new Proxy({} as Record<string | symbol, unknown>, {
  get: (t, p) => (p in t ? t[p] : () => undefined),
  set: (t, p, v) => {
    t[p] = v
    return true
  }
})

/** the DOM the views build: elements that keep their class, text, dataset, style and children */
class FakeElement {
  className = ''
  textContent = ''
  hidden = false
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  classList = { toggle() {}, add() {}, remove() {} }
  children: FakeElement[] = []
  width = 0
  height = 0
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }
  replaceChildren(...nodes: FakeElement[]): void {
    this.children = nodes
  }
  addEventListener(): void {}
  getContext(): unknown {
    return ctx
  }
}

/** the frame the view has asked for, which the test runs by hand */
let pending: FrameRequestCallback | null = null

function frame(now: number): void {
  const cb = pending
  expect(cb).not.toBeNull()
  pending = null
  cb!(now)
}

function find(el: FakeElement, cls: string): FakeElement | undefined {
  if (el.className === cls) return el
  for (const child of el.children) {
    const found = find(child, cls)
    if (found !== undefined) return found
  }
  return undefined
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new FakeElement(), documentElement: new FakeElement() })
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending = cb
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    pending = null
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  pending = null
})

describe('LanderView', () => {
  it('asks for a frame only while live and in play', () => {
    const view = new LanderView(0, () => {}, () => 1)
    view.setState(true, true)
    expect(pending).toBeNull()
    view.key('Space', true)
    expect(pending).not.toBeNull()
    view.setState(true, false)
    expect(pending).toBeNull()
    view.setState(true, true)
    expect(pending).not.toBeNull()
    view.setState(false, false)
    expect(pending).toBeNull()
  })

  it('a key while not live does nothing', () => {
    const view = new LanderView(0, () => {}, () => 1)
    view.setState(true, false)
    expect(view.key('Space', true)).toBe(true)
    expect(view.el.dataset.phase).toBe('ready')
    expect(pending).toBeNull()
  })

  it('held keys are forgotten when the game stops being live', () => {
    const view = new LanderView(0, () => {}, () => 1)
    view.setState(true, true)
    view.key('ArrowUp', true)
    view.setState(true, false)
    view.setState(true, true)
    // the craft starts its clock here; the step that follows has no thrust, so the fuel stays whole
    frame(0)
    frame(100)
    expect(view.el.dataset.fuel).toBe('100')
  })

  it('thrust burns fuel while the key is held', () => {
    const view = new LanderView(0, () => {}, () => 1)
    view.setState(true, true)
    view.key('ArrowUp', true)
    frame(0)
    frame(100)
    expect(Number(view.el.dataset.fuel)).toBeLessThan(100)
  })

  it('writes its best into the save', () => {
    const view = new LanderView(77, () => {}, () => 1)
    const save = { ...EMPTY_GAMES }
    view.saveInto(save)
    expect(save.landerBest).toBe(77)
    expect(view.menuNote()).toBe('best 77')
  })

  it('Space starts a run, and Space after a crash starts a new one', () => {
    let now = 0
    const view = new LanderView(0, () => {}, () => 1)
    expect(view.canPause()).toBe(false)
    view.setState(true, true)
    view.key('Space', true)
    expect(view.canPause()).toBe(true)
    expect(view.el.dataset.phase).toBe('flying')
    view.key('Space', false)
    // no thrust: the craft drops onto the ground far too fast to land
    for (let i = 0; i < 1000 && view.el.dataset.phase !== 'crashed'; i++) {
      now += 16
      frame(now)
    }
    expect(view.el.dataset.phase).toBe('crashed')
    view.key('Space', true)
    expect(view.el.dataset.phase).toBe('flying')
    expect(view.el.dataset.level).toBe('1')
    expect(find(view.el as unknown as FakeElement, 'lander-score')?.textContent).toBe('score 0')
  })

  it('a landing raises the best, and tells the window', () => {
    // the run starts with the craft at rest just over the middle of the pad
    const overPad = (seed: number): LanderState => {
      const r = newRun(seed)
      const x = (r.terrain.padX0 + r.terrain.padX1) / 2
      return { ...r, x, y: r.terrain.padY - LANDER.footY - 2, vx: 0, vy: 0, angle: 0 }
    }
    let changed = 0
    const view = new LanderView(0, () => changed++, () => 1, overPad)
    view.setState(true, true)
    view.key('Space', true)
    view.key('Space', false)
    frame(0)
    for (let now = 16; now <= 1000 && view.el.dataset.phase !== 'landed'; now += 16) frame(now)
    expect(view.el.dataset.phase).toBe('landed')
    expect(changed).toBeGreaterThan(0)
    const save = { ...EMPTY_GAMES }
    view.saveInto(save)
    expect(save.landerBest).toBeGreaterThan(0)
    expect(view.menuNote()).toBe(`best ${save.landerBest}`)
  })
})

describe('PinballView', () => {
  it('asks for a frame only while live and in play', () => {
    const view = new PinballView(0, () => {})
    view.setState(true, true)
    expect(pending).toBeNull()
    view.key('Space', true)
    expect(pending).not.toBeNull()
    view.setState(true, false)
    expect(pending).toBeNull()
    view.setState(true, true)
    expect(pending).not.toBeNull()
    view.setState(false, false)
    expect(pending).toBeNull()
  })

  it('a key while not live does nothing', () => {
    const view = new PinballView(0, () => {})
    view.setState(true, false)
    expect(view.key('Space', true)).toBe(true)
    expect(view.el.dataset.phase).toBe('ready')
    expect(pending).toBeNull()
  })

  it('held keys are forgotten when the game stops being live', () => {
    const view = new PinballView(0, () => {})
    view.setState(true, true)
    view.key('Space', true)
    view.setState(true, false)
    view.setState(true, true)
    frame(0)
    frame(100)
    expect(view.el.dataset.power).toBe('0')
    expect(view.el.dataset.ball).toBe('plunger')
  })

  it('Space pulls the plunger and its release launches the ball', () => {
    const view = new PinballView(0, () => {})
    view.setState(true, true)
    view.key('Space', true)
    for (let now = 0; now <= 500; now += 100) frame(now)
    expect(Number(view.el.dataset.power)).toBeGreaterThan(40)
    view.key('Space', false)
    frame(516)
    expect(view.el.dataset.ball).toBe('loose')
  })

  it('a tap shorter than a frame still acts: it pulls the plunger, and the next frame launches', () => {
    const view = new PinballView(0, () => {})
    view.setState(true, true)
    view.key('Space', true)
    view.key('Space', false)
    frame(0)
    frame(100)
    expect(Number(view.el.dataset.power)).toBeGreaterThan(0)
    expect(view.el.dataset.ball).toBe('plunger')
    frame(200)
    expect(view.el.dataset.ball).toBe('loose')
  })

  it('a pull stopped by a pause goes back: the resume does not launch the ball', () => {
    const view = new PinballView(0, () => {})
    view.setState(true, true)
    view.key('Space', true)
    for (let now = 0; now <= 300; now += 100) frame(now)
    expect(Number(view.el.dataset.power)).toBeGreaterThan(0)
    // paused mid-pull; Space comes up while the game is paused
    view.setState(true, false)
    view.key('Space', false)
    view.setState(true, true)
    frame(400)
    frame(500)
    expect(view.el.dataset.ball).toBe('plunger')
    expect(view.el.dataset.power).toBe('0')
  })

  it('writes its best into the save', () => {
    const view = new PinballView(77, () => {})
    const save = { ...EMPTY_GAMES }
    view.saveInto(save)
    expect(save.pinballBest).toBe(77)
    expect(view.menuNote()).toBe('best 77')
  })
})

describe('SandView', () => {
  it('asks for a frame only while live and in play', () => {
    const view = new SandView(0, () => {}, () => 1)
    view.setState(true, true)
    expect(pending).toBeNull()
    view.key('Space', true)
    expect(pending).not.toBeNull()
    view.setState(true, false)
    expect(pending).toBeNull()
    view.setState(true, true)
    expect(pending).not.toBeNull()
    view.setState(false, false)
    expect(pending).toBeNull()
  })

  it('a key while not live does nothing', () => {
    const view = new SandView(0, () => {}, () => 1)
    view.setState(true, false)
    expect(view.key('Space', true)).toBe(true)
    expect(view.el.dataset.phase).toBe('ready')
    expect(pending).toBeNull()
  })

  it('held keys are forgotten when the game stops being live', () => {
    const view = new SandView(0, () => {}, () => 1)
    view.setState(true, true)
    view.key('Space', true)
    view.key('ArrowLeft', true)
    view.setState(true, false)
    view.setState(true, true)
    frame(0)
    const before = view.el.dataset.pieceX
    for (let now = 50; now <= 1000; now += 50) frame(now)
    expect(view.el.dataset.pieceX).toBe(before)
  })

  it('writes its best into the save', () => {
    const view = new SandView(77, () => {}, () => 1)
    const save = { ...EMPTY_GAMES }
    view.saveInto(save)
    expect(save.sandBest).toBe(77)
    expect(view.menuNote()).toBe('best 77')
  })

  it('←/→ move the piece a cell', () => {
    const view = new SandView(0, () => {}, () => 1)
    view.setState(true, true)
    view.key('Space', true)
    frame(0)
    const x = Number(view.el.dataset.pieceX)
    view.key('ArrowRight', true)
    view.key('ArrowRight', false)
    frame(16)
    expect(Number(view.el.dataset.pieceX)).toBe(x + SAND.k)
    // a tap acts in one frame only
    frame(32)
    expect(Number(view.el.dataset.pieceX)).toBe(x + SAND.k)
  })

  it('a clear raises the best, and tells the window', () => {
    // one-colour sand fills the bottom cell row from wall to wall but for a gap under where a dash of that colour appears
    const DASH = PIECES.findIndex((p) => p.name === 'dash')
    const gapped = (seed: number): SandState => {
      const g = newGame(seed)
      const grid = new Uint8Array(SAND.width * SAND.height)
      const dash = spawn(DASH, 0)
      for (let y = SAND.height - SAND.k; y < SAND.height; y++) {
        for (let x = 0; x < SAND.width; x++) if (x < dash.x || x >= dash.x + 3 * SAND.k) grid[y * SAND.width + x] = grain(0, 0)
      }
      return { ...g, grid, next: { shape: DASH, color: 0 } }
    }
    let changed = 0
    const view = new SandView(0, () => changed++, () => 1, gapped)
    view.setState(true, true)
    // Space starts the game, then drops the dash into the gap
    view.key('Space', true)
    view.key('Space', false)
    frame(0)
    view.key('Space', true)
    view.key('Space', false)
    frame(16)
    frame(32)
    expect(Number(view.el.dataset.score)).toBeGreaterThan(0)
    expect(changed).toBeGreaterThan(0)
    expect(view.menuNote()).toBe(`best ${view.el.dataset.score}`)
  })
})
