import { describe, expect, it } from 'vitest'
import { frontClears, PENDING_ACTIVATE_MS, RemoteFront } from '../../src/main/remote-front'

const T1 = 'd1000000-0000-4000-8000-000000000001'
const T2 = 'd1000000-0000-4000-8000-000000000002'
const A = 'a1000000-0000-4000-8000-000000000001'
const B = 'b1000000-0000-4000-8000-000000000001'

describe('RemoteFront: the tab a new-tab request opened comes to the front only if the person did not pick another tab', () => {
  it('an activation between the mark and the answer skips the front', () => {
    const f = new RemoteFront()
    const m = f.mark()
    f.activated()
    expect(f.answered(m, T1, true, 0, A)).toBe('skip')
    expect(f.arrived(T1, 0)).toBe(false)
  })

  it('a tab already listed when the answer comes is activated at once, and nothing is left pending', () => {
    const f = new RemoteFront()
    const m = f.mark()
    expect(f.answered(m, T1, true, 0, A)).toBe('activate')
    expect(f.arrived(T1, 0)).toBe(false)
  })

  it('a tab not listed yet waits, and arrives once', () => {
    const f = new RemoteFront()
    const m = f.mark()
    expect(f.answered(m, T1, false, 0, A)).toBe('wait')
    expect(f.arrived(T1, 1)).toBe(true)
    expect(f.arrived(T1, 2)).toBe(false)
  })

  it('a tab the person brings forward clears the pending tab, a local one and a remote one alike', () => {
    // index.ts reports both through activated(): a local tab in front, and a remote tab the person picked
    const f = new RemoteFront()
    const m = f.mark()
    f.answered(m, T1, false, 0, A)
    f.activated()
    expect(f.arrived(T1, 1)).toBe(false)
  })

  it('a remote tab an open-tab request brings forward does not skip a later request', () => {
    const f = new RemoteFront()
    const first = f.mark()
    const second = f.mark()
    expect(f.answered(first, T1, true, 0, A)).toBe('activate')
    f.activatedByRequest()
    expect(f.answered(second, T2, true, 1, A)).toBe('activate')
  })

  it('a pending tab that arrives, and is activated by its request, does not skip a later request either', () => {
    const f = new RemoteFront()
    const first = f.mark()
    const second = f.mark()
    expect(f.answered(first, T1, false, 0, A)).toBe('wait')
    expect(f.arrived(T1, 1)).toBe(true)
    f.activatedByRequest()
    expect(f.answered(second, T2, true, 2, A)).toBe('activate')
  })

  it('a person activation after both marks skips the second request', () => {
    const f = new RemoteFront()
    const first = f.mark()
    const second = f.mark()
    expect(f.answered(first, T1, true, 0, A)).toBe('activate')
    f.activatedByRequest()
    f.activated()
    expect(f.answered(second, T2, true, 1, A)).toBe('skip')
  })

  it('the device going offline clears the pending tab of that device only', () => {
    const f = new RemoteFront()
    const m = f.mark()
    f.answered(m, T1, false, 0, A)
    f.deviceGone(B)
    expect(f.arrived(T1, 1)).toBe(true)
    f.answered(f.mark(), T2, false, 2, A)
    f.deviceGone(A)
    expect(f.arrived(T2, 3)).toBe(false)
  })

  it('the tab closing clears the pending tab', () => {
    const f = new RemoteFront()
    f.answered(f.mark(), T1, false, 0, A)
    f.closed(T2)
    expect(f.arrived(T1, 1)).toBe(true)
    f.answered(f.mark(), T1, false, 2, A)
    f.closed(T1)
    expect(f.arrived(T1, 3)).toBe(false)
  })

  it('the pending tab expires 15 s after its answer', () => {
    const f = new RemoteFront()
    f.answered(f.mark(), T1, false, 1000, A)
    expect(PENDING_ACTIVATE_MS).toBe(15_000)
    expect(f.arrived(T1, 1000 + PENDING_ACTIVATE_MS - 1)).toBe(true)
    f.answered(f.mark(), T1, false, 1000, A)
    expect(f.arrived(T1, 1000 + PENDING_ACTIVATE_MS)).toBe(false)
  })

  it('a second open replaces the first pending tab', () => {
    const f = new RemoteFront()
    f.answered(f.mark(), T1, false, 0, A)
    f.answered(f.mark(), T2, false, 0, A)
    expect(f.arrived(T1, 1)).toBe(false)
    expect(f.arrived(T2, 1)).toBe(true)
  })
})

describe("frontClears: a member's front clears the tab's attention only when the front changed or its window gained the focus", () => {
  const was = (tabId: string, focused: boolean) => ({ tabId, focused })

  it('a new tab in front clears', () => {
    expect(frontClears(was(T1, false), T2, false)).toBe(true)
    expect(frontClears(was(T1, true), T2, true)).toBe(true)
  })

  it('the same tab gaining the focus clears', () => {
    expect(frontClears(was(T1, false), T1, true)).toBe(true)
  })

  it('the same tab losing the focus does not clear', () => {
    expect(frontClears(was(T1, true), T1, false)).toBe(false)
  })

  it('the same tab re-sent with no change does not clear', () => {
    expect(frontClears(was(T1, false), T1, false)).toBe(false)
    expect(frontClears(was(T1, true), T1, true)).toBe(false)
  })

  it('no record of the member (a reconnect, or its first front) clears', () => {
    expect(frontClears(undefined, T1, false)).toBe(true)
    expect(frontClears(undefined, T1, true)).toBe(true)
  })
})
