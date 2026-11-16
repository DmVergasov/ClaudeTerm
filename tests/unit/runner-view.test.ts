import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunnerView } from '../../src/renderer/games/runner-view'

/** a canvas context that takes any drawing call and does nothing with it */
const ctx = new Proxy({} as Record<string | symbol, unknown>, {
  get: (t, p) => (p in t ? t[p] : () => undefined),
  set: (t, p, v) => {
    t[p] = v
    return true
  }
})

/** the DOM the view builds: elements that keep their class, text, dataset and children */
class FakeElement {
  className = ''
  textContent = ''
  hidden = false
  dataset: Record<string, string> = {}
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

describe('RunnerView', () => {
  it('a run that started after an ended one starts its clock at its first frame, not at the old frame', () => {
    let now = 0
    // every obstacle is a ground one, so Clawd, who never jumps, is hit within a few seconds
    const view = new RunnerView(0, () => {}, () => 0.5)
    view.setState(true, true)
    view.key('Space', true)
    for (let i = 0; i < 1000 && view.el.dataset.phase !== 'over'; i++) {
      now += 16
      frame(now)
    }
    expect(view.el.dataset.phase).toBe('over')

    // the next run starts after five seconds: its first frame only sets the clock, so the score does not move
    view.key('Space', true)
    now += 5000
    frame(now)
    expect(find(view.el as unknown as FakeElement, 'runner-score')?.textContent).toBe('score 0')
  })
})
