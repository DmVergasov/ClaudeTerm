import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROMPT_QUERY_TIMEOUT_MS, PromptQueries } from '../../src/main/prompt-query'

function setup(windowOpen = true) {
  const sent: [number, string][] = []
  const q = new PromptQueries({ send: (queryId, tabId) => { sent.push([queryId, tabId]); return windowOpen } })
  return { q, sent }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('PromptQueries', () => {
  it('asks the window about the tab and takes its answer to that query', async () => {
    const { q, sent } = setup()
    const first = q.ask('t1')
    const second = q.ask('t2')
    expect(sent.map(([, tab]) => tab)).toEqual(['t1', 't2'])
    q.answer(sent[1]![0], 'draft')
    q.answer(sent[0]![0], 'empty')
    await expect(first).resolves.toBe('empty')
    await expect(second).resolves.toBe('draft')
  })

  it('without a window, or without an answer in time, there is no prompt to type into', async () => {
    await expect(setup(false).q.ask('t1')).resolves.toBe('none')
    const { q } = setup()
    const late = q.ask('t1')
    await vi.advanceTimersByTimeAsync(PROMPT_QUERY_TIMEOUT_MS)
    await expect(late).resolves.toBe('none')
  })

  it('ignores answers to no query and answers that are not a prompt state', async () => {
    const { q, sent } = setup()
    const pending = q.ask('t1')
    const id = sent[0]![0]
    q.answer(id + 1, 'empty')
    q.answer(String(id), 'empty')
    q.answer(id, 'full')
    q.answer(id, 'draft')
    q.answer(id, 'empty')
    await expect(pending).resolves.toBe('draft')
  })
})
