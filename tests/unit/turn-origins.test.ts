import { describe, expect, it } from 'vitest'
import { TurnOrigins } from '../../src/main/turn-origins'

const S1 = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const S2 = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('TurnOrigins', () => {
  it('a tab with no reports has no peer turn', () => {
    const t = new TurnOrigins()
    expect(t.lastTurnIsPeer('t1')).toBe(false)
  })

  it('the last turn is peer when the turn with the highest index was started by a message from another session', () => {
    const t = new TurnOrigins()
    t.session('t1', S1)
    t.report('t1', 0, false)
    t.report('t1', 1, true)
    expect(t.lastTurnIsPeer('t1')).toBe(true)
    t.report('t1', 2, false)
    expect(t.lastTurnIsPeer('t1')).toBe(false)
  })

  it('the first report of a turn decides its origin: a message that joins a human turn mid-way does not change it', () => {
    const t = new TurnOrigins()
    t.session('t1', S1)
    t.report('t1', 3, false)
    t.report('t1', 3, true)
    expect(t.lastTurnIsPeer('t1')).toBe(false)
    t.report('t1', 4, true)
    t.report('t1', 4, false)
    expect(t.lastTurnIsPeer('t1')).toBe(true)
  })

  it('a report of an earlier turn does not change the last one', () => {
    const t = new TurnOrigins()
    t.session('t1', S1)
    t.report('t1', 5, false)
    t.report('t1', 4, true)
    expect(t.lastTurnIsPeer('t1')).toBe(false)
  })

  it('tabs keep their own turns', () => {
    const t = new TurnOrigins()
    t.report('t1', 0, true)
    t.report('t2', 0, false)
    expect(t.lastTurnIsPeer('t1')).toBe(true)
    expect(t.lastTurnIsPeer('t2')).toBe(false)
  })

  it('a session with another id forgets the turns of the tab; the same id keeps them', () => {
    const t = new TurnOrigins()
    t.session('t1', S1)
    t.report('t1', 2, true)
    t.session('t1', S1)
    expect(t.lastTurnIsPeer('t1')).toBe(true)
    t.session('t1', S2)
    expect(t.lastTurnIsPeer('t1')).toBe(false)
    t.report('t1', 0, false)
    expect(t.lastTurnIsPeer('t1')).toBe(false)
  })

  it('removeTab forgets the turns of the tab', () => {
    const t = new TurnOrigins()
    t.session('t1', S1)
    t.report('t1', 1, true)
    t.removeTab('t1')
    expect(t.lastTurnIsPeer('t1')).toBe(false)
  })
})
