import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIALOG_SHIM, PageDriver, StaleRefError } from '../../src/main/browser/page-driver'
import type { Cdp } from '../../src/main/browser/page-driver'
import type { AXNode } from '../../src/main/browser/snapshot'
import ax from '../fixtures/ax-tree-login.json'

type Handler = (params: unknown) => void
type Answer = unknown | ((params: Record<string, unknown> | undefined) => unknown)

/** A Cdp that records every send, answers from a table of canned results and lets the test emit events */
class FakeCdp implements Cdp {
  readonly sent: { method: string; params?: Record<string, unknown> }[] = []
  private readonly answers = new Map<string, Answer>()
  private readonly handlers = new Map<string, Handler[]>()

  answer(method: string, result: Answer): void {
    this.answers.set(method, result)
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.sent.push({ method, params })
    const a = this.answers.get(method)
    try {
      const value = typeof a === 'function' ? (a as (p: Record<string, unknown> | undefined) => unknown)(params) : a
      return Promise.resolve(value as T)
    } catch (e) {
      return Promise.reject(e)
    }
  }

  on(event: string, fn: (params: any) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
  }

  emit(event: string, params: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(params)
  }

  methods(): string[] {
    return this.sent.map((s) => s.method)
  }

  calls(method: string): { method: string; params?: Record<string, unknown> }[] {
    return this.sent.filter((s) => s.method === method)
  }
}

const nodes = ax as AXNode[]

/** a page with the login fixture snapshotted: e2 is the Email box (backend id 102) */
async function snapshotted(cdp: FakeCdp, driver: PageDriver): Promise<void> {
  cdp.answer('Accessibility.getFullAXTree', { nodes })
  await driver.snapshot()
}

/** a box whose content quad centres on (60, 40) */
const BOX = { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } }

/** the page may read every request's body */
const READABLE = (): boolean => true

function consoleCall(type: string, ...values: unknown[]): unknown {
  return { type, args: values.map((v) => ({ type: typeof v, value: v })) }
}

describe('PageDriver: enable', () => {
  it('enables the six domains, then installs the dialog shim for new and current documents', async () => {
    const cdp = new FakeCdp()
    await new PageDriver(cdp).enable()
    expect(cdp.methods()).toEqual([
      'Page.enable',
      'Runtime.enable',
      'Network.enable',
      'Log.enable',
      'DOM.enable',
      'Accessibility.enable',
      'Page.getFrameTree',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.evaluate',
    ])
    expect(cdp.calls('Page.addScriptToEvaluateOnNewDocument')[0].params).toEqual({ source: DIALOG_SHIM })
    expect(cdp.calls('Runtime.evaluate')[0].params).toEqual({ expression: DIALOG_SHIM })
  })
})

describe('PageDriver: the main frame\'s requested navigation', () => {
  it('keeps the last navigation the main frame asked for, with its reason; a subframe\'s request is not kept', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Page.getFrameTree', { frameTree: { frame: { id: 'main-frame' } } })
    const driver = new PageDriver(cdp)
    await driver.enable()
    cdp.emit('Page.frameRequestedNavigation', { frameId: 'main-frame', reason: 'anchorClick', url: 'http://other.test/first' })
    cdp.emit('Page.frameRequestedNavigation', { frameId: 'sub-frame', reason: 'formSubmissionGet', url: 'http://other.test/sub' })
    cdp.emit('Page.frameRequestedNavigation', { frameId: 'main-frame', reason: 'formSubmissionPost', url: 'http://other.test/page' })
    expect(driver.requestedNavigation()).toEqual({ url: 'http://other.test/page', reason: 'formSubmissionPost' })
  })

  it('counts the main frame\'s requests; a subframe\'s request is not counted', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Page.getFrameTree', { frameTree: { frame: { id: 'main-frame' } } })
    const driver = new PageDriver(cdp)
    await driver.enable()
    expect(driver.requestCount()).toBe(0)
    cdp.emit('Page.frameRequestedNavigation', { frameId: 'main-frame', reason: 'anchorClick', url: 'http://other.test/a' })
    cdp.emit('Page.frameRequestedNavigation', { frameId: 'sub-frame', reason: 'formSubmissionGet', url: 'http://other.test/b' })
    expect(driver.requestCount()).toBe(1)
  })

  it('a request for a new tab is neither counted nor kept', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Page.getFrameTree', { frameTree: { frame: { id: 'main-frame' } } })
    const driver = new PageDriver(cdp)
    await driver.enable()
    cdp.emit('Page.frameRequestedNavigation', { frameId: 'main-frame', reason: 'anchorClick', url: 'http://other.test/tab', disposition: 'newTab' })
    expect(driver.requestCount()).toBe(0)
    expect(driver.requestedNavigation()).toBeNull()
  })

  it('a main-frame navigation that commits clears the kept request', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Page.getFrameTree', { frameTree: { frame: { id: 'main-frame' } } })
    const driver = new PageDriver(cdp)
    await driver.enable()
    cdp.emit('Page.frameRequestedNavigation', { frameId: 'main-frame', reason: 'formSubmissionPost', url: 'http://other.test/page' })
    cdp.emit('Page.frameNavigated', { frame: { id: 'main-frame' } })
    expect(driver.requestedNavigation()).toBeNull()
  })
})

describe('PageDriver: snapshot', () => {
  it('returns the text of the login fixture and keeps its refs for the next command', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('Accessibility.getFullAXTree', { nodes })
    cdp.answer('DOM.getBoxModel', BOX)
    const text = await driver.snapshot()
    expect(text).toBe([
      '- heading "Sign in" [level=1] [ref=e1]',
      '- text: "Use your work account."',
      '- textbox "Email": "ada@example.test" [ref=e2]',
      '- textbox "Password" [ref=e3]',
      '- checkbox "Remember me" [checked] [ref=e4]',
      '- button "Sign in" [ref=e5]',
      '- link "Forgot password?" [ref=e6]',
      '- group "Other ways"',
      '  - link "Sign in with SSO" [ref=e7]',
      '    - text: "Use single sign-on"',
      '- text: "Need help? Ask the admin desk."',
    ].join('\n'))
    await driver.click('e2', 'left', false)
    expect(cdp.calls('DOM.getBoxModel')[0].params).toEqual({ backendNodeId: 102 })
  })
})

describe('PageDriver: click', () => {
  let cdp: FakeCdp
  let driver: PageDriver

  beforeEach(async () => {
    cdp = new FakeCdp()
    driver = new PageDriver(cdp)
    cdp.answer('DOM.getBoxModel', BOX)
    await snapshotted(cdp, driver)
  })

  it('scrolls the element into view, then moves, presses and releases at the centre of its box', async () => {
    await driver.click('e2', 'left', false)
    expect(cdp.methods().slice(-5)).toEqual([
      'DOM.scrollIntoViewIfNeeded',
      'DOM.getBoxModel',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ])
    expect(cdp.calls('DOM.scrollIntoViewIfNeeded').at(-1)?.params).toEqual({ backendNodeId: 102 })
    const mouse = cdp.calls('Input.dispatchMouseEvent').map((c) => c.params)
    expect(mouse).toEqual([
      { type: 'mouseMoved', x: 60, y: 40 },
      { type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 60, y: 40, button: 'left', clickCount: 1 },
    ])
  })

  it('a double click adds a second press and release with clickCount 2', async () => {
    await driver.click('e2', 'right', true)
    const pressed = cdp.calls('Input.dispatchMouseEvent').map((c) => c.params).filter((p) => p?.type !== 'mouseMoved')
    expect(pressed).toEqual([
      { type: 'mousePressed', x: 60, y: 40, button: 'right', clickCount: 1 },
      { type: 'mouseReleased', x: 60, y: 40, button: 'right', clickCount: 1 },
      { type: 'mousePressed', x: 60, y: 40, button: 'right', clickCount: 2 },
      { type: 'mouseReleased', x: 60, y: 40, button: 'right', clickCount: 2 },
    ])
  })

  it('rejects a ref that the snapshot never gave with StaleRefError and sends nothing', async () => {
    const before = cdp.sent.length
    await expect(driver.click('e99', 'left', false)).rejects.toBeInstanceOf(StaleRefError)
    expect(cdp.sent.length).toBe(before)
  })

  it('rejects with StaleRefError when the box of the element cannot be computed', async () => {
    cdp.answer('DOM.getBoxModel', () => {
      throw new Error('Could not compute box model.')
    })
    await expect(driver.click('e2', 'left', false)).rejects.toBeInstanceOf(StaleRefError)
  })

  it('a DOM error that says the node is gone is a StaleRefError', async () => {
    cdp.answer('DOM.getBoxModel', () => {
      throw new Error('Could not find node with given id')
    })
    await expect(driver.click('e2', 'left', false)).rejects.toBeInstanceOf(StaleRefError)
  })

  it('another CDP error, such as a detached debugger, is passed on as it is', async () => {
    cdp.answer('DOM.getBoxModel', () => {
      throw new Error('Debugger is not attached to the tab')
    })
    const error = await driver.click('e2', 'left', false).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(StaleRefError)
    expect((error as Error).message).toBe('Debugger is not attached to the tab')
  })

  it('rejects with StaleRefError after a main-frame navigation clears the refs', async () => {
    cdp.emit('Page.frameNavigated', { frame: { id: 'f1', url: 'http://localhost:1/next' } })
    await expect(driver.click('e2', 'left', false)).rejects.toBeInstanceOf(StaleRefError)
  })

  it('keeps the refs after a subframe navigation', async () => {
    cdp.emit('Page.frameNavigated', { frame: { id: 'f2', parentId: 'f1', url: 'http://localhost:1/ad' } })
    await expect(driver.click('e2', 'left', false)).resolves.toBeUndefined()
  })
})

describe('PageDriver: type', () => {
  let cdp: FakeCdp
  let driver: PageDriver

  beforeEach(async () => {
    cdp = new FakeCdp()
    driver = new PageDriver(cdp)
    cdp.answer('DOM.getBoxModel', BOX)
    await snapshotted(cdp, driver)
  })

  it('focuses the element and inserts the text at once', async () => {
    await driver.type('e2', 'ada', false, false)
    expect(cdp.calls('DOM.focus')[0].params).toEqual({ backendNodeId: 102 })
    expect(cdp.calls('Input.insertText').map((c) => c.params)).toEqual([{ text: 'ada' }])
    expect(cdp.calls('Input.dispatchKeyEvent')).toEqual([])
  })

  it('presses Enter after the text when submit is set', async () => {
    await driver.type('e2', 'ada', true, false)
    const keys = cdp.calls('Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys).toEqual([
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 },
    ])
  })

  it('types slowly, one key event pair per character, then submits', async () => {
    await driver.type('e2', 'ab', true, true)
    expect(cdp.calls('Input.insertText')).toEqual([])
    const keys = cdp.calls('Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys.map((k) => [k?.type, k?.key])).toEqual([
      ['keyDown', 'a'],
      ['keyUp', 'a'],
      ['keyDown', 'b'],
      ['keyUp', 'b'],
      ['keyDown', 'Enter'],
      ['keyUp', 'Enter'],
    ])
  })

  it('types a character that has no key event as text', async () => {
    await driver.type('e2', '+', false, true)
    expect(cdp.calls('Input.insertText').map((c) => c.params)).toEqual([{ text: '+' }])
  })

  it('rejects a stale ref with StaleRefError', async () => {
    await expect(driver.type('e77', 'x', false, false)).rejects.toBeInstanceOf(StaleRefError)
  })
})

describe('PageDriver: pressKey', () => {
  it('sends the key events of a known key', async () => {
    const cdp = new FakeCdp()
    await new PageDriver(cdp).pressKey('Enter')
    expect(cdp.calls('Input.dispatchKeyEvent').map((c) => c.params?.type)).toEqual(['keyDown', 'keyUp'])
  })

  it('throws for a key it does not know, and sends nothing', async () => {
    const cdp = new FakeCdp()
    await expect(new PageDriver(cdp).pressKey('Nope')).rejects.toThrow('Unknown key: Nope')
    expect(cdp.sent).toEqual([])
  })
})

describe('PageDriver: hover', () => {
  it('moves the mouse to the centre of the element', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('DOM.getBoxModel', BOX)
    await snapshotted(cdp, driver)
    await driver.hover('e5')
    expect(cdp.calls('Input.dispatchMouseEvent').at(-1)?.params).toEqual({ type: 'mouseMoved', x: 60, y: 40 })
  })
})

describe('PageDriver: selectOption', () => {
  it('calls the select function on the element and returns the values it selected', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('Accessibility.getFullAXTree', {
      nodes: [
        { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, childIds: ['2'] },
        { nodeId: '2', parentId: '1', ignored: false, role: { value: 'combobox' }, name: { value: 'Size' }, backendDOMNodeId: 9 },
      ],
    })
    await driver.snapshot()
    cdp.answer('DOM.resolveNode', { object: { objectId: 'o1' } })
    cdp.answer('Runtime.callFunctionOn', { result: { type: 'object', value: ['medium'] } })
    await expect(driver.selectOption('e1', ['medium', 'M'])).resolves.toEqual(['medium'])
    expect(cdp.calls('DOM.resolveNode')[0].params).toEqual({ backendNodeId: 9 })
    const call = cdp.calls('Runtime.callFunctionOn')[0].params
    expect(call).toMatchObject({ objectId: 'o1', arguments: [{ value: ['medium', 'M'] }], returnByValue: true })
    expect(String(call?.functionDeclaration)).toContain('dispatchEvent')
  })

  it('runs the function the driver sends on a select: the chosen option is selected and input and change are dispatched', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('Accessibility.getFullAXTree', {
      nodes: [
        { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, childIds: ['2'] },
        { nodeId: '2', parentId: '1', ignored: false, role: { value: 'combobox' }, name: { value: 'Size' }, backendDOMNodeId: 9 },
      ],
    })
    await driver.snapshot()
    cdp.answer('DOM.resolveNode', { object: { objectId: 'o1' } })
    cdp.answer('Runtime.callFunctionOn', (p: Record<string, unknown> | undefined) => ({
      result: { type: 'object', value: p?.arguments ? ['b'] : [] },
    }))
    await driver.selectOption('e1', ['b'])
    const decl = String(cdp.calls('Runtime.callFunctionOn')[0].params?.functionDeclaration)

    class FakeSelect {
      readonly dispatched: string[] = []
      constructor(readonly options: { value: string; label: string; selected: boolean }[]) {}
      get selectedOptions() {
        return this.options.filter((o) => o.selected)
      }
      dispatchEvent(e: { type: string }): boolean {
        this.dispatched.push(e.type)
        return true
      }
    }
    vi.stubGlobal('HTMLSelectElement', FakeSelect)
    try {
      const select = new FakeSelect([
        { value: 'a', label: 'Alpha', selected: true },
        { value: 'b', label: 'Beta', selected: false },
      ])
      const run = new Function(`return (${decl})`)() as (this: unknown, wanted: string[]) => string[]
      expect(run.call(select, ['b'])).toEqual(['b'])
      expect(select.options.map((o) => o.selected)).toEqual([false, true])
      expect(select.dispatched).toEqual(['input', 'change'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('PageDriver: scroll', () => {
  it('wheels at the centre of the visible page when no ref is given', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Page.getLayoutMetrics', { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } })
    await new PageDriver(cdp).scroll(null, 'down', 300)
    expect(cdp.calls('Input.dispatchMouseEvent')[0].params).toEqual({ type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 300 })
  })

  it('wheels the other way and sideways with the amount as a signed delta', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Page.getLayoutMetrics', { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } })
    const driver = new PageDriver(cdp)
    await driver.scroll(null, 'up', 100)
    await driver.scroll(null, 'left', 50)
    expect(cdp.calls('Input.dispatchMouseEvent').map((c) => [c.params?.deltaX, c.params?.deltaY])).toEqual([[0, -100], [-50, 0]])
  })

  it('wheels at the centre of the element when a ref is given', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('DOM.getBoxModel', BOX)
    await snapshotted(cdp, driver)
    await driver.scroll('e2', 'right', 10)
    expect(cdp.calls('Input.dispatchMouseEvent').at(-1)?.params).toEqual({ type: 'mouseWheel', x: 60, y: 40, deltaX: 10, deltaY: 0 })
  })
})

describe('PageDriver: waitFor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls the page text every 250 ms until the text appears', async () => {
    const cdp = new FakeCdp()
    let polls = 0
    cdp.answer('Runtime.evaluate', () => ({ result: { type: 'string', value: ++polls < 3 ? 'Loading' : 'Welcome back' } }))
    const done = vi.fn()
    const wait = new PageDriver(cdp).waitFor('Welcome', null, null, new AbortController().signal).then(done)
    await vi.advanceTimersByTimeAsync(250)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    await wait
    expect(done).toHaveBeenCalledOnce()
    expect(polls).toBe(3)
    expect(cdp.calls('Runtime.evaluate')[0].params).toMatchObject({ returnByValue: true })
  })

  it('waits until the text is gone', async () => {
    const cdp = new FakeCdp()
    let polls = 0
    cdp.answer('Runtime.evaluate', () => ({ result: { type: 'string', value: ++polls < 2 ? 'Saving…' : 'Saved' } }))
    const done = vi.fn()
    const wait = new PageDriver(cdp).waitFor(null, 'Saving…', null, new AbortController().signal).then(done)
    await vi.advanceTimersByTimeAsync(500)
    await wait
    expect(done).toHaveBeenCalledOnce()
    expect(polls).toBe(2)
  })

  it('sleeps for the seconds given without reading the page', async () => {
    const cdp = new FakeCdp()
    const done = vi.fn()
    const wait = new PageDriver(cdp).waitFor(null, null, 2, new AbortController().signal).then(done)
    await vi.advanceTimersByTimeAsync(1900)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    await wait
    expect(done).toHaveBeenCalledOnce()
    expect(cdp.calls('Runtime.evaluate')).toEqual([])
  })

  it('gives up after 60 s with the text in the message', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Runtime.evaluate', { result: { type: 'string', value: 'Loading' } })
    const wait = new PageDriver(cdp).waitFor('Never', null, null, new AbortController().signal)
    const failed = expect(wait).rejects.toThrow('Timed out waiting for "Never".')
    await vi.advanceTimersByTimeAsync(60_000)
    await failed
  })

  it('gives up at 60 s when a poll never answers, with the timeout message', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Runtime.evaluate', () => new Promise(() => {}))
    const wait = new PageDriver(cdp).waitFor('Never', null, null, new AbortController().signal)
    const failed = expect(wait).rejects.toThrow('Timed out waiting for "Never".')
    await vi.advanceTimersByTimeAsync(60_000)
    await failed
  })

  it('stops at once when the signal aborts while a poll is pending', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Runtime.evaluate', () => new Promise(() => {}))
    const controller = new AbortController()
    const wait = new PageDriver(cdp).waitFor('x', null, null, controller.signal)
    const failed = expect(wait).rejects.toThrow('The wait was cancelled.')
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await failed
  })

  it('a time over 60 s waits 60 s, and reads no page text', async () => {
    const cdp = new FakeCdp()
    const done = vi.fn()
    const wait = new PageDriver(cdp).waitFor(null, null, 90, new AbortController().signal).then(done)
    await vi.advanceTimersByTimeAsync(60_000)
    await wait
    expect(done).toHaveBeenCalledOnce()
    expect(cdp.calls('Runtime.evaluate')).toEqual([])
  })

  it('rejects at once when the signal is already aborted', async () => {
    const cdp = new FakeCdp()
    const signal = AbortSignal.abort()
    await expect(new PageDriver(cdp).waitFor('x', null, null, signal)).rejects.toThrow(Error)
    expect(cdp.sent).toEqual([])
  })

  it('stops a wait in progress when the signal aborts', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Runtime.evaluate', { result: { type: 'string', value: 'Loading' } })
    const controller = new AbortController()
    const wait = new PageDriver(cdp).waitFor('x', null, null, controller.signal)
    const failed = expect(wait).rejects.toThrow(Error)
    await vi.advanceTimersByTimeAsync(500)
    controller.abort()
    await failed
  })
})

describe('PageDriver: screenshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('captures the viewport as a png', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Page.captureScreenshot', { data: 'AAAA' })
    await expect(new PageDriver(cdp).screenshot(false, null)).resolves.toEqual({ data: 'AAAA', mimeType: 'image/png' })
    expect(cdp.calls('Page.captureScreenshot')[0].params).toEqual({ format: 'png', captureBeyondViewport: false })
  })

  it('clips a full page to the content size and captures beyond the viewport', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Page.getLayoutMetrics', { cssContentSize: { width: 1000, height: 3000 } })
    cdp.answer('Page.captureScreenshot', { data: 'AAAA' })
    await new PageDriver(cdp).screenshot(true, null)
    expect(cdp.calls('Page.captureScreenshot')[0].params).toEqual({
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1000, height: 3000, scale: 1 },
    })
  })

  it('clips an element to its box in page coordinates', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('DOM.getBoxModel', BOX)
    cdp.answer('Page.getLayoutMetrics', { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 5, pageY: 7 } })
    cdp.answer('Page.captureScreenshot', { data: 'AAAA' })
    await snapshotted(cdp, driver)
    await driver.screenshot(false, 'e2')
    expect(cdp.calls('Page.captureScreenshot')[0].params?.clip).toEqual({ x: 15, y: 27, width: 100, height: 40, scale: 1 })
  })

  it('captures again as a jpeg of quality 70 when the png is over 4 000 000 characters', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Page.captureScreenshot', (p: Record<string, unknown> | undefined) => ({ data: p?.format === 'jpeg' ? 'JPEG' : 'x'.repeat(4_000_001) }))
    await expect(new PageDriver(cdp).screenshot(false, null)).resolves.toEqual({ data: 'JPEG', mimeType: 'image/jpeg' })
    expect(cdp.calls('Page.captureScreenshot').map((c) => c.params?.format)).toEqual(['png', 'jpeg'])
    expect(cdp.calls('Page.captureScreenshot')[1].params).toMatchObject({ format: 'jpeg', quality: 70 })
  })

  it('gives up after 10 s when the page does not paint', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Page.captureScreenshot', () => new Promise(() => {}))
    const shot = new PageDriver(cdp).screenshot(false, null)
    const failed = expect(shot).rejects.toThrow('The page did not paint in time; try again.')
    await vi.advanceTimersByTimeAsync(10_000)
    await failed
  })
})

describe('PageDriver: evaluate', () => {
  it('runs the function in the page and returns its result as JSON', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Runtime.evaluate', { result: { type: 'string', value: 'Sign in' } })
    await expect(new PageDriver(cdp).evaluate('() => document.title', null)).resolves.toBe('"Sign in"')
    expect(cdp.calls('Runtime.evaluate')[0].params).toEqual({
      expression: '(() => document.title\n)()',
      awaitPromise: true,
      returnByValue: true,
    })
  })

  it('ends the function on its own line, so a trailing line comment cannot swallow the call', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Runtime.evaluate', { result: { type: 'number', value: 1 } })
    await new PageDriver(cdp).evaluate('() => 1 // note', null)
    expect(cdp.calls('Runtime.evaluate')[0].params?.expression).toBe('(() => 1 // note\n)()')
  })

  it('calls the function with the element when a ref is given', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('DOM.getBoxModel', BOX)
    await snapshotted(cdp, driver)
    cdp.answer('DOM.resolveNode', { object: { objectId: 'o7' } })
    cdp.answer('Runtime.callFunctionOn', { result: { type: 'number', value: 3 } })
    await expect(driver.evaluate('(el) => el.value.length', 'e2')).resolves.toBe('3')
    expect(cdp.calls('Runtime.callFunctionOn')[0].params).toEqual({
      objectId: 'o7',
      functionDeclaration: '(el) => el.value.length',
      arguments: [{ objectId: 'o7' }],
      awaitPromise: true,
      returnByValue: true,
    })
  })

  it('throws the description of an exception the function raised, with and without a ref', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    const threw = { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } } }
    cdp.answer('Runtime.evaluate', threw)
    await expect(driver.evaluate('() => { throw 1 }', null)).rejects.toThrow('TypeError: boom')
    cdp.answer('DOM.getBoxModel', BOX)
    await snapshotted(cdp, driver)
    cdp.answer('DOM.resolveNode', { object: { objectId: 'o7' } })
    cdp.answer('Runtime.callFunctionOn', threw)
    await expect(driver.evaluate('() => null', 'e2')).rejects.toThrow('TypeError: boom')
  })

  it('cuts the JSON of the result to 50 000 characters', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Runtime.evaluate', { result: { type: 'string', value: 'x'.repeat(60_000) } })
    const text = await new PageDriver(cdp).evaluate('() => "x"', null)
    expect(Array.from(text)).toHaveLength(50_000)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('PageDriver: console', () => {
  it('prints each line as [level] text', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Runtime.consoleAPICalled', consoleCall('log', 'hello', 3))
    expect(driver.consoleText(false)).toBe('[log] hello 3')
  })

  it('keeps the last 500 lines of a page', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    for (let i = 0; i <= 500; i++) cdp.emit('Runtime.consoleAPICalled', consoleCall('log', `m${i}`))
    const lines = driver.consoleText(false).split('\n')
    expect(lines).toHaveLength(500)
    expect(lines[0]).toBe('[log] m1')
    expect(lines[499]).toBe('[log] m500')
  })

  it('lists only the errors when onlyErrors is set: console errors, uncaught exceptions and error log entries', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Runtime.consoleAPICalled', consoleCall('log', 'fine'))
    cdp.emit('Runtime.consoleAPICalled', consoleCall('error', 'failed'))
    cdp.emit('Log.entryAdded', { entry: { source: 'network', level: 'warning', text: 'slow' } })
    cdp.emit('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource' } })
    cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } } })
    expect(driver.consoleText(true)).toBe('[error] failed\n[error] Failed to load resource\n[error] TypeError: boom')
  })

  it('counts an uncaught exception as a new error for the footer', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: x is not defined' } } })
    expect(driver.takeFooterNews().newErrors).toEqual(['[error] ReferenceError: x is not defined'])
  })

  it('reports each new error once through takeFooterNews, then none', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Runtime.consoleAPICalled', consoleCall('error', 'first'))
    cdp.emit('Runtime.consoleAPICalled', consoleCall('log', 'not an error'))
    expect(driver.takeFooterNews().newErrors).toEqual(['[error] first'])
    expect(driver.takeFooterNews().newErrors).toEqual([])
    cdp.emit('Log.entryAdded', { entry: { level: 'error', text: 'second' } })
    expect(driver.takeFooterNews().newErrors).toEqual(['[error] second'])
  })

  it('cuts a console line to 2 000 characters', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Runtime.consoleAPICalled', consoleCall('log', 'a'.repeat(2500)))
    expect(driver.consoleText(false)).toBe(`[log] ${'a'.repeat(1999)}…`)
  })

  it('takes events with missing or wrong fields without throwing', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    expect(() => {
      cdp.emit('Runtime.consoleAPICalled', {})
      cdp.emit('Runtime.consoleAPICalled', { type: 3, args: 'x' })
      cdp.emit('Runtime.consoleAPICalled', { args: [null, { value: { nested: true } }] })
      cdp.emit('Runtime.exceptionThrown', {})
      cdp.emit('Log.entryAdded', { entry: 'x' })
      cdp.emit('Network.requestWillBeSent', {})
      cdp.emit('Network.requestWillBeSent', { requestId: 'a', request: 'x' })
      cdp.emit('Network.responseReceived', { requestId: 'nope' })
      cdp.emit('Network.loadingFailed', null)
      cdp.emit('Page.javascriptDialogOpening', {})
      cdp.emit('Page.frameNavigated', { frame: 'x' })
      cdp.emit('Page.frameNavigated', undefined)
    }).not.toThrow()
    expect(driver.consoleText(false).split('\n').length).toBeGreaterThan(0)
  })
})

describe('PageDriver: network', () => {
  function request(cdp: FakeCdp, requestId: string, url: string, method = 'GET'): void {
    cdp.emit('Network.requestWillBeSent', { requestId, request: { url, method, headers: {} } })
  }

  it('prints each request as id, method, URL, status and type', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    request(cdp, '1000.1', 'http://localhost:1/a')
    cdp.emit('Network.responseReceived', { requestId: '1000.1', type: 'Document', response: { status: 200, headers: {} } })
    expect(driver.networkText()).toBe('r1 GET http://localhost:1/a → 200 Document')
  })

  it('prints a request that has no answer yet as pending, and a failed one with its error', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    request(cdp, '1', 'http://localhost:1/slow')
    request(cdp, '2', 'http://localhost:1/gone', 'POST')
    cdp.emit('Network.loadingFailed', { requestId: '2', errorText: 'net::ERR_CONNECTION_REFUSED' })
    expect(driver.networkText()).toBe([
      'r1 GET http://localhost:1/slow → pending',
      'r2 POST http://localhost:1/gone → failed: net::ERR_CONNECTION_REFUSED',
    ].join('\n'))
  })

  it('keeps the last 500 requests and numbers them across the page', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    for (let i = 1; i <= 501; i++) request(cdp, `q${i}`, `http://localhost:1/${i}`)
    const lines = driver.networkText().split('\n')
    expect(lines).toHaveLength(500)
    expect(lines[0]).toBe('r2 GET http://localhost:1/2 → pending')
  })

  it('cuts a URL to 500 characters', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    request(cdp, '1', `http://localhost:1/${'p'.repeat(600)}`)
    expect(driver.networkText()).toBe(`r1 GET http://localhost:1/${'p'.repeat(500 - 'http://localhost:1/'.length - 1)}… → pending`)
  })

  it('gives the headers and the response body of a request by its id, the body cut to 100 000 characters', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('Network.getResponseBody', { body: 'b'.repeat(120_000), base64Encoded: false })
    cdp.emit('Network.requestWillBeSent', {
      requestId: '9',
      request: { url: 'http://localhost:1/api', method: 'POST', headers: { 'content-type': 'application/json' }, postData: 'hello' },
    })
    cdp.emit('Network.responseReceived', {
      requestId: '9', type: 'Fetch', response: { status: 201, headers: { 'x-trace': 'abc' } },
    })
    const lines = (await driver.requestText('r1', READABLE)).split('\n')
    expect(lines.slice(0, 9)).toEqual([
      'r1 POST http://localhost:1/api → 201 Fetch',
      '### Request headers',
      '- content-type: application/json',
      '### Request body',
      'hello',
      '### Response headers',
      '- x-trace: abc',
      '### Response body',
      `${'b'.repeat(99_999)}…`,
    ])
    expect(cdp.calls('Network.getResponseBody')[0].params).toEqual({ requestId: '9' })
  })

  it('shows a response body only when the page may be read there: a request to a site not allowed in the tab keeps its headers and shows no body', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('Network.getResponseBody', { body: 'secret body text', base64Encoded: false })
    cdp.emit('Network.requestWillBeSent', { requestId: '9', request: { url: 'http://other.test:1/api', method: 'GET', headers: {} } })
    cdp.emit('Network.responseReceived', { requestId: '9', type: 'Fetch', response: { status: 200, headers: { 'x-trace': 'abc' } } })
    const text = await driver.requestText('r1', () => false)
    expect(text).toContain('- x-trace: abc')
    expect(text.endsWith('### Response body\n(not shown: other.test is not allowed in this tab)')).toBe(true)
    expect(text).not.toContain('secret body text')
    expect(cdp.calls('Network.getResponseBody')).toEqual([])
  })

  it('a redirect from a readable URL to an unreadable one shows no body for either hop, since CDP keeps the last hop\'s body under the shared id', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('Network.getResponseBody', { body: 'bank body', base64Encoded: false })
    cdp.emit('Network.requestWillBeSent', { requestId: '7', request: { url: 'http://localhost:1/r', method: 'GET', headers: {} } })
    cdp.emit('Network.requestWillBeSent', { requestId: '7', request: { url: 'http://other.test:1/bank', method: 'GET', headers: {} }, redirectResponse: { status: 302 } })
    cdp.emit('Network.responseReceived', { requestId: '7', type: 'Fetch', response: { status: 200, url: 'http://other.test:1/bank', headers: {} } })
    const local = (u: string): boolean => u.startsWith('http://localhost:1/')
    for (const id of ['r1', 'r2']) {
      expect((await driver.requestText(id, local)).endsWith('### Response body\n(not shown: other.test is not allowed in this tab)')).toBe(true)
    }
    expect(cdp.calls('Network.getResponseBody')).toEqual([])
  })

  it('a redirect whose every hop is readable shows its body', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('Network.getResponseBody', { body: 'local body', base64Encoded: false })
    cdp.emit('Network.requestWillBeSent', { requestId: '8', request: { url: 'http://localhost:1/go', method: 'GET', headers: {} } })
    cdp.emit('Network.requestWillBeSent', { requestId: '8', request: { url: 'http://localhost:1/done', method: 'GET', headers: {} }, redirectResponse: { status: 302 } })
    cdp.emit('Network.responseReceived', { requestId: '8', type: 'Fetch', response: { status: 200, url: 'http://localhost:1/done', headers: {} } })
    const local = (u: string): boolean => u.startsWith('http://localhost:1/')
    expect((await driver.requestText('r2', local)).endsWith('### Response body\nlocal body')).toBe(true)
  })

  it('a redirect from an unreadable URL to a readable one shows no body either: the first hop is read too', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('Network.getResponseBody', { body: 'final body', base64Encoded: false })
    cdp.emit('Network.requestWillBeSent', { requestId: '9', request: { url: 'http://other.test:1/go', method: 'GET', headers: {} } })
    cdp.emit('Network.requestWillBeSent', { requestId: '9', request: { url: 'http://localhost:1/done', method: 'GET', headers: {} }, redirectResponse: { status: 302 } })
    cdp.emit('Network.responseReceived', { requestId: '9', type: 'Fetch', response: { status: 200, url: 'http://localhost:1/done', headers: {} } })
    const local = (u: string): boolean => u.startsWith('http://localhost:1/')
    expect((await driver.requestText('r1', local)).endsWith('### Response body\n(not shown: other.test is not allowed in this tab)')).toBe(true)
  })

  it('a data: body is readable, and a blob: body is readable when the origin inside it is', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('Network.getResponseBody', { body: 'shown body', base64Encoded: false })
    cdp.emit('Network.requestWillBeSent', { requestId: '1', request: { url: 'data:text/plain,hi', method: 'GET', headers: {} } })
    cdp.emit('Network.requestWillBeSent', { requestId: '2', request: { url: 'blob:https://site.test:9/0b1e-uuid', method: 'GET', headers: {} } })
    const none = (): boolean => false
    const siteOnly = (u: string): boolean => u === 'https://site.test:9/'
    expect((await driver.requestText('r1', none)).endsWith('### Response body\nshown body')).toBe(true)
    expect((await driver.requestText('r2', siteOnly)).endsWith('### Response body\nshown body')).toBe(true)
    expect((await driver.requestText('r2', none)).endsWith('### Response body\n(not shown: another address is not allowed in this tab)')).toBe(true)
  })

  it('cuts the request body to 100 000 characters, and prints none when the request has no body', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('Network.getResponseBody', { body: '', base64Encoded: false })
    cdp.emit('Network.requestWillBeSent', { requestId: '1', request: { url: 'http://localhost:1/up', method: 'PUT', headers: {}, postData: 'p'.repeat(120_000) } })
    cdp.emit('Network.requestWillBeSent', { requestId: '2', request: { url: 'http://localhost:1/get', method: 'GET', headers: {} } })
    const first = (await driver.requestText('r1', READABLE)).split('\n')
    expect(first[3]).toBe('### Request body')
    expect(first[4]).toBe(`${'p'.repeat(99_999)}…`)
    expect((await driver.requestText('r2', READABLE)).split('\n').slice(3, 5)).toEqual(['### Request body', '(none)'])
  })

  it('says a binary body is not shown, and that a body is not available when CDP has none', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('Network.getResponseBody', { body: 'AAEC', base64Encoded: true })
    request(cdp, '1', 'http://localhost:1/img.png')
    expect((await driver.requestText('r1', READABLE)).endsWith('### Response body\n(binary, 4 characters in base64; not shown)')).toBe(true)
    cdp.answer('Network.getResponseBody', () => {
      throw new Error('No resource with given identifier found')
    })
    expect((await driver.requestText('r1', READABLE)).endsWith('### Response body\n(not available)')).toBe(true)
  })

  it('rejects an id that is not in the list', async () => {
    const cdp = new FakeCdp()
    await expect(new PageDriver(cdp).requestText('r3', READABLE)).rejects.toThrow('No request r3 in the list.')
  })

  it('clears the request list on a main-frame navigation', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    request(cdp, '1', 'http://localhost:1/a')
    cdp.emit('Page.frameNavigated', { frame: { id: 'f1', url: 'http://localhost:1/next' } })
    expect(driver.networkText()).toBe('')
    await expect(driver.requestText('r1', READABLE)).rejects.toThrow('No request r1 in the list.')
  })
})

describe('PageDriver: navigation', () => {
  it('clears the console lines on a main-frame navigation and keeps the new page\'s', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Runtime.consoleAPICalled', consoleCall('log', 'old page'))
    cdp.emit('Page.frameNavigated', { frame: { id: 'f1', url: 'http://localhost:1/next' } })
    cdp.emit('Runtime.consoleAPICalled', consoleCall('log', 'new page'))
    expect(driver.consoleText(false)).toBe('[log] new page')
  })

  it('keeps the console lines on a subframe navigation', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Runtime.consoleAPICalled', consoleCall('log', 'kept'))
    cdp.emit('Page.frameNavigated', { frame: { id: 'f2', parentId: 'f1', url: 'http://localhost:1/ad' } })
    expect(driver.consoleText(false)).toBe('[log] kept')
  })

  it('drops the errors and dialogs of the old page from the footer news on a main-frame navigation', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Runtime.consoleAPICalled', consoleCall('error', 'old page error'))
    cdp.emit('Runtime.consoleAPICalled', consoleCall('log', '__ct_dialog__{"type":"alert","message":"old page dialog","answer":"OK"}'))
    cdp.emit('Page.frameNavigated', { frame: { id: 'f1', url: 'http://localhost:1/next' } })
    expect(driver.takeFooterNews()).toEqual({ newErrors: [], dialogs: [] })
  })

  it('keeps the errors of a subframe navigation in the footer news', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Runtime.consoleAPICalled', consoleCall('error', 'kept error'))
    cdp.emit('Page.frameNavigated', { frame: { id: 'f2', parentId: 'f1', url: 'http://localhost:1/ad' } })
    expect(driver.takeFooterNews().newErrors).toEqual(['[error] kept error'])
  })
})

describe('PageDriver: dialogs', () => {
  const shimLine = (json: string): unknown => consoleCall('debug', `__ct_dialog__${json}`)

  it('takes a dialog the shim reports from the console, once, and keeps it out of the console', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Runtime.consoleAPICalled', shimLine('{"type":"confirm","message":"y","answer":"Cancel"}'))
    expect(driver.takeFooterNews().dialogs).toEqual([{ type: 'confirm', message: 'y', answer: 'Cancel' }])
    expect(driver.takeFooterNews().dialogs).toEqual([])
    expect(driver.consoleText(false)).toBe('')
  })

  it('ignores a malformed shim line: it is in neither the console nor the dialogs', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Runtime.consoleAPICalled', shimLine('{'))
    cdp.emit('Runtime.consoleAPICalled', shimLine('{"type":1,"message":"m","answer":"OK"}'))
    expect(driver.consoleText(false)).toBe('')
    expect(driver.takeFooterNews().dialogs).toEqual([])
  })

  it('arms the answer of the next dialog with handleDialog, without a dialog open', async () => {
    const cdp = new FakeCdp()
    await new PageDriver(cdp).handleDialog(true, 'typed')
    expect(cdp.calls('Runtime.evaluate')[0].params).toEqual({ expression: 'window.__ctDialog = {"accept":true,"text":"typed"}' })
    expect(cdp.calls('Page.handleJavaScriptDialog')).toEqual([])
  })

  it('records a dialog the shim did not catch with the answer Cancel, and never answers it', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })
    expect(driver.takeFooterNews().dialogs).toEqual([{ type: 'confirm', message: 'Sure?', answer: 'Cancel' }])
    expect(cdp.calls('Page.handleJavaScriptDialog')).toEqual([])
  })

  it('leaves a beforeunload the page opens to the tab, which answers it and reports it: the driver neither records nor answers it', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Page.javascriptDialogOpening', { type: 'beforeunload', message: '' })
    expect(driver.takeFooterNews().dialogs).toEqual([])
    expect(cdp.calls('Page.handleJavaScriptDialog')).toEqual([])
  })

  it('records an alert that CDP reports as closed', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Saved' })
    expect(driver.takeFooterNews().dialogs).toEqual([{ type: 'alert', message: 'Saved', answer: 'closed' }])
  })

  it('keeps the last 20 dialogs', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    for (let i = 1; i <= 21; i++) cdp.emit('Page.javascriptDialogOpening', { type: 'alert', message: `m${i}` })
    const dialogs = driver.takeFooterNews().dialogs
    expect(dialogs).toHaveLength(20)
    expect(dialogs[0].message).toBe('m2')
  })
})

describe('PageDriver: a stopped command stops its steps', () => {
  it('pressKey sends nothing when its signal has stopped already', async () => {
    const cdp = new FakeCdp()
    const stop = new AbortController()
    stop.abort()
    await expect(new PageDriver(cdp).pressKey('Enter', stop.signal)).rejects.toThrow('The wait was cancelled.')
    expect(cdp.sent).toEqual([])
  })

  it('pressKey sends a started combo in full, its key-ups included, and nothing after it', async () => {
    const cdp = new FakeCdp()
    const stop = new AbortController()
    cdp.answer('Input.dispatchKeyEvent', () => {
      stop.abort()
      return {}
    })
    await new PageDriver(cdp).pressKey('Control+Enter', stop.signal)
    const types = cdp.calls('Input.dispatchKeyEvent').map((c) => `${c.params?.type}:${c.params?.key}`)
    expect(types).toEqual(['keyDown:Control', 'rawKeyDown:Enter', 'keyUp:Enter', 'keyUp:Control'])
  })

  it('scroll sends no wheel turn once its signal has stopped', async () => {
    const cdp = new FakeCdp()
    cdp.answer('Page.getLayoutMetrics', { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 }, cssContentSize: { width: 800, height: 600 } })
    const stop = new AbortController()
    stop.abort()
    await expect(new PageDriver(cdp).scroll(null, 'down', 100, stop.signal)).rejects.toThrow('The wait was cancelled.')
    expect(cdp.calls('Input.dispatchMouseEvent')).toEqual([])
  })

  it('type, typed slowly, stops before the next character', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('DOM.getBoxModel', BOX)
    await snapshotted(cdp, driver)
    const stop = new AbortController()
    cdp.answer('Input.dispatchKeyEvent', () => {
      stop.abort()
      return {}
    })
    await expect(driver.type('e2', 'abc', false, true, stop.signal)).rejects.toThrow('The wait was cancelled.')
    // the character that started is sent with its key-up; the next one is not
    expect(cdp.calls('Input.dispatchKeyEvent').map((c) => c.params?.type)).toEqual(['keyDown', 'keyUp'])
    expect(cdp.calls('Input.insertText')).toEqual([])
  })

  it('click that stops after a press still releases the button, and presses no more', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('DOM.getBoxModel', BOX)
    await snapshotted(cdp, driver)
    const stop = new AbortController()
    cdp.answer('Input.dispatchMouseEvent', (params?: Record<string, unknown>) => {
      if (params?.type === 'mousePressed') stop.abort()
      return {}
    })
    await expect(driver.click('e2', 'left', true, stop.signal)).rejects.toThrow('The wait was cancelled.')
    expect(cdp.calls('Input.dispatchMouseEvent').map((c) => c.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('click stops between its mouse events', async () => {
    const cdp = new FakeCdp()
    const driver = new PageDriver(cdp)
    cdp.answer('DOM.getBoxModel', BOX)
    await snapshotted(cdp, driver)
    const stop = new AbortController()
    cdp.answer('Input.dispatchMouseEvent', () => {
      stop.abort()
      return {}
    })
    await expect(driver.click('e2', 'left', false, stop.signal)).rejects.toThrow('The wait was cancelled.')
    expect(cdp.calls('Input.dispatchMouseEvent').map((c) => c.params?.type)).toEqual(['mouseMoved'])
  })
})
