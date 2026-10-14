import { describe, expect, it } from 'vitest'
import { grownBounds, PanelRoom, type PanelWindow, type Rect } from '../../src/main/panel-room'

const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 }

describe('grownBounds', () => {
  it('grows the window to the right when that fits the work area', () => {
    expect(grownBounds({ x: 100, y: 50, width: 1000, height: 700 }, AREA, 360)).toEqual({ x: 100, y: 50, width: 1360, height: 700 })
  })

  it('moves the window left when it would cross the right edge of the work area', () => {
    expect(grownBounds({ x: 1000, y: 50, width: 800, height: 700 }, AREA, 360)).toEqual({ x: 760, y: 50, width: 1160, height: 700 })
  })

  it('cannot grow a window past the width of the work area', () => {
    expect(grownBounds({ x: 0, y: 0, width: 1700, height: 700 }, AREA, 360)).toBeNull()
    expect(grownBounds({ x: 0, y: 0, width: 1560, height: 700 }, AREA, 360)).toEqual({ x: 0, y: 0, width: 1920, height: 700 })
  })

  it('keeps the window on its own display', () => {
    expect(grownBounds({ x: 3000, y: 0, width: 600, height: 500 }, { x: 1920, y: 0, width: 1280, height: 1000 }, 400)).toEqual({ x: 2200, y: 0, width: 1000, height: 500 })
  })
})

interface Fake extends PanelWindow {
  b: Rect
  area: Rect
  isPinned: boolean
  /** a window manager that keeps the window's size */
  refuse: boolean
  calls: Rect[]
}

function fakeWindow(b: Rect = { x: 100, y: 50, width: 1000, height: 700 }): Fake {
  const w: Fake = {
    b,
    area: AREA,
    isPinned: false,
    refuse: false,
    calls: [],
    minWidth: 480,
    bounds: () => ({ ...w.b }),
    setBounds: async (r) => {
      w.calls.push(r)
      await new Promise((resolve) => setTimeout(resolve, 1))
      if (!w.refuse) w.b = { ...r }
    },
    workArea: () => w.area,
    pinned: () => w.isPinned
  }
  return w
}

describe('PanelRoom', () => {
  it('opening the panel widens the window by its width, and closing it gives that width back', async () => {
    const w = fakeWindow()
    const room = new PanelRoom(w, () => 'overlay')
    expect(await room.set(360, true)).toBe('beside')
    expect(w.b).toEqual({ x: 100, y: 50, width: 1360, height: 700 })
    expect(room.added).toBe(360)
    expect(await room.set(0, true)).toBe('beside')
    expect(w.b).toEqual({ x: 100, y: 50, width: 1000, height: 700 })
    expect(room.added).toBe(0)
  })

  it('a panel of another width changes the window by the difference', async () => {
    const w = fakeWindow()
    const room = new PanelRoom(w, () => 'overlay')
    await room.set(360, true)
    expect(await room.set(640, true)).toBe('beside')
    expect(w.b.width).toBe(1640)
    expect(await room.set(360, true)).toBe('beside')
    expect(w.b.width).toBe(1360)
    await room.set(0, true)
    expect(w.b.width).toBe(1000)
  })

  it('without room for the panel the window stays as it is and the panel is shown the way sidePanel.noRoom says', async () => {
    const w = fakeWindow({ x: 0, y: 0, width: 1700, height: 700 })
    let noRoom: 'overlay' | 'narrow' = 'overlay'
    const room = new PanelRoom(w, () => noRoom)
    expect(await room.set(360, true)).toBe('overlay')
    noRoom = 'narrow'
    expect(await room.set(640, true)).toBe('narrow')
    expect(await room.set(0, true)).toBe('beside')
    expect(w.calls).toEqual([])
    expect(w.b.width).toBe(1700)
  })

  it('a maximized or full screen window is not resized', async () => {
    const w = fakeWindow()
    w.isPinned = true
    const room = new PanelRoom(w, () => 'narrow')
    expect(await room.set(360, true)).toBe('narrow')
    expect(await room.set(0, true)).toBe('beside')
    expect(w.calls).toEqual([])
  })

  it('a panel closed while the window was maximized gives its width back when the window is restored', async () => {
    const w = fakeWindow()
    const room = new PanelRoom(w, () => 'overlay')
    await room.set(360, true)
    w.isPinned = true
    expect(await room.refit()).toBe('overlay')
    await room.set(0, true)
    expect(w.calls).toHaveLength(1)
    w.isPinned = false
    expect(await room.refit()).toBe('beside')
    expect(w.b.width).toBe(1000)
  })

  it('a panel kept open while the window was maximized sits beside it again when the window is restored', async () => {
    const w = fakeWindow()
    const room = new PanelRoom(w, () => 'overlay')
    await room.set(360, true)
    w.isPinned = true
    expect(await room.refit()).toBe('overlay')
    w.isPinned = false
    expect(await room.refit()).toBe('beside')
    expect(w.b.width).toBe(1360)
    expect(w.calls).toHaveLength(1)
  })

  it('a panel opened while the window was maximized widens the window when it is restored', async () => {
    const w = fakeWindow()
    w.isPinned = true
    const room = new PanelRoom(w, () => 'overlay')
    expect(await room.set(360, true)).toBe('overlay')
    w.isPinned = false
    expect(await room.refit()).toBe('beside')
    expect(w.b.width).toBe(1360)
  })

  it('a window manager that keeps the size: the panel is shown as without room, and closing it does not narrow the window', async () => {
    const w = fakeWindow()
    w.refuse = true
    const room = new PanelRoom(w, () => 'overlay')
    expect(await room.set(360, true)).toBe('overlay')
    expect(room.added).toBe(0)
    await room.set(0, true)
    expect(w.calls).toHaveLength(1)
    expect(w.b.width).toBe(1000)
  })

  it('dragging the panel edge leaves the window as it is, and closing then gives back the width the panel has', async () => {
    const w = fakeWindow()
    const room = new PanelRoom(w, () => 'overlay')
    await room.set(360, true)
    expect(await room.set(500, false)).toBe('beside')
    expect(w.calls).toHaveLength(1)
    expect(room.added).toBe(500)
    await room.set(0, true)
    expect(w.b.width).toBe(860)
  })

  it('dragging the edge of a panel shown without room does not count as room', async () => {
    const w = fakeWindow({ x: 0, y: 0, width: 1700, height: 700 })
    const room = new PanelRoom(w, () => 'overlay')
    await room.set(360, true)
    expect(await room.set(500, false)).toBe('overlay')
    expect(room.added).toBe(0)
  })

  it('closing never makes the window narrower than its minimum width', async () => {
    const w = fakeWindow()
    const room = new PanelRoom(w, () => 'overlay')
    await room.set(360, true)
    w.b = { ...w.b, width: 600 }
    await room.set(0, true)
    expect(w.b.width).toBe(480)
    expect(room.added).toBe(0)
  })

  it('requests run one after another, in the order they came', async () => {
    const w = fakeWindow()
    const room = new PanelRoom(w, () => 'overlay')
    const modes = await Promise.all([room.set(360, true), room.set(0, true), room.set(640, true)])
    expect(modes).toEqual(['beside', 'beside', 'beside'])
    expect(w.calls.map((r) => r.width)).toEqual([1360, 1000, 1640])
  })
})
