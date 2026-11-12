import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChatModel } from '../../src/main/chat/chat-model'
import { parseChatPush } from '../../src/main/chat/chat-mirror'
import type { ChatPatch } from '../../src/shared/chat'
import { fixtureHistory, fixtureLines } from '../fixtures/chat-fixtures'

// The contract between the host's model and the member's check: every batch the model makes from the recorded protocol
// passes parseChatPush, and so does the final snapshot. The clock is run twice: as it runs, and stepping back, as the wall
// clock does after a correction; a duration the clock makes negative must not make the member refuse the chat.

const TAB = '0a1b2c3d-0000-4000-8000-000000000002'
const FIXTURES = resolve(import.meta.dirname, '../fixtures/chat')

/** a model with ids of its own and the work folder /work/acme; `clock` gives the time of each call */
function modelWith(clock: () => number): ChatModel {
  let n = 0
  return new ChatModel({ now: clock, newId: () => `id${++n}`, folder: () => '/work/acme' })
}

/** a clock that moves on */
function runningClock(): () => number {
  let t = 1_000_000
  return () => (t += 10)
}

/** a clock that steps back by 5 s on every third reading */
function steppingClock(): () => number {
  let t = 1_000_000
  let reads = 0
  return () => {
    reads++
    t += 10
    return reads % 3 === 0 ? t - 5_000 : t
  }
}

/** the model's patches for each message, batched as the host batches them (one revision per patch); counts the batches refused */
function replay(m: ChatModel, messages: unknown[]): { refused: number; rev: number } {
  let rev = 0
  let refused = 0
  for (const msg of messages) {
    const patches: ChatPatch[] = m.apply(msg)
    if (patches.length === 0) continue
    if (parseChatPush({ fromRev: rev, toRev: rev + patches.length, patches }) === null) refused++
    rev += patches.length
  }
  return { refused, rev }
}

const names = readdirSync(FIXTURES).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -'.jsonl'.length)).sort()

describe('the chat model and the member check agree on every recorded fixture', () => {
  const clocks: [string, () => () => number][] = [['a clock that runs on', runningClock], ['a clock that steps back', steppingClock]]
  for (const [clockName, clockOf] of clocks) {
    for (const name of names) {
      it(`${name}, ${clockName}: every batch and the final snapshot pass parseChatPush`, () => {
        const m = modelWith(clockOf())
        const { refused, rev } = replay(m, fixtureLines(name, 'out'))
        expect(refused).toBe(0)
        const page = m.page()
        expect(parseChatPush({ tabId: TAB, rev, items: page.items, hasOlder: page.hasOlder, state: m.state() })).not.toBeNull()
      })
    }

    it(`history.json, ${clockName}: every batch and the final snapshot pass parseChatPush`, () => {
      const m = modelWith(clockOf())
      const { refused, rev } = replay(m, fixtureHistory())
      const patches = m.historyLoaded()
      const last = rev + patches.length
      expect(refused + (patches.length > 0 && parseChatPush({ fromRev: rev, toRev: last, patches }) === null ? 1 : 0)).toBe(0)
      const page = m.page()
      expect(parseChatPush({ tabId: TAB, rev: last, items: page.items, hasOlder: page.hasOlder, state: m.state() })).not.toBeNull()
    })
  }
})
