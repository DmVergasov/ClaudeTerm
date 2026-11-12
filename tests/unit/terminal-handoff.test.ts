import { describe, expect, it, vi } from 'vitest'
import { isHandoffLine, openInTerminal, type HandoffDeps } from '../../src/main/chat/terminal-handoff'
import type { TabView } from '../../src/shared/chat'
import type { PromptState } from '../../src/shared/ipc'

const TAB = 'tab-1'

/**
 * The handoff's dependencies as fakes: the prompt answers `states` one after the other (the last one again after them),
 * the switch answers `switched`, and every call is recorded in order so a test can see what came before what.
 */
function fakeDeps(states: PromptState[], switched = true) {
  const calls: string[] = []
  const notes: string[] = []
  const toasts: string[] = []
  const views: TabView[] = []
  let answered = 0
  const deps: HandoffDeps = {
    setView: async (_tabId, view) => {
      views.push(view)
      calls.push(`view:${view}`)
      return switched
    },
    promptState: async () => {
      calls.push('prompt')
      const state = states[Math.min(answered, states.length - 1)]
      answered++
      return state
    },
    write: (_tabId, data) => calls.push(`write:${data}`),
    note: (_tabId, text) => notes.push(text),
    toast: (text) => toasts.push(text),
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`)
    },
    exists: () => true,
  }
  return { deps, calls, notes, toasts, views }
}

const writes = (calls: string[]): string[] => calls.filter((c) => c.startsWith('write:'))

describe('openInTerminal', () => {
  it('switches to the terminal, waits through a prompt that is not empty, then types the line and Enter', async () => {
    const { deps, calls, notes, views } = fakeDeps(['none', 'draft', 'empty'])
    expect(await openInTerminal(TAB, '/config', '/config', deps)).toBe(true)

    expect(views).toEqual(['terminal'])
    expect(calls.filter((c) => c === 'prompt')).toHaveLength(3)
    expect(writes(calls)).toEqual(['write:/config', 'write:\r'])
    // nothing is typed before the prompt is empty
    const thirdPrompt = calls.lastIndexOf('prompt')
    expect(calls.indexOf('write:/config')).toBeGreaterThan(thirdPrompt)
    expect(notes).toEqual(['Opened /config in the terminal'])
  })

  it('a refused switch writes nothing, asks nothing and notes nothing', async () => {
    const { deps, calls, notes } = fakeDeps(['empty'], false)
    expect(await openInTerminal(TAB, '/config', '/config', deps)).toBe(false)
    expect(calls).toEqual(['view:terminal'])
    expect(notes).toEqual([])
  })

  it('a handoff that times out also shows a toast, as its note does', async () => {
    const { deps, toasts, notes } = fakeDeps(['none'])
    await openInTerminal(TAB, '/config', '/config', deps)
    expect(toasts).toEqual(["Could not run /config: Claude Code's prompt did not come up"])
    expect(notes).toEqual(toasts)
  })

  it('a prompt that never empties in 30 s writes nothing and says why', async () => {
    const { deps, calls, notes } = fakeDeps(['none'])
    expect(await openInTerminal(TAB, '/config', '/config', deps)).toBe(true)

    expect(writes(calls)).toEqual([])
    const slept = calls.filter((c) => c.startsWith('sleep:')).reduce((sum, c) => sum + Number(c.slice('sleep:'.length)), 0)
    expect(slept).toBe(30_000)
    expect(notes).toEqual(["Could not run /config: Claude Code's prompt did not come up"])
  })

  it('a null line only switches the tab', async () => {
    const { deps, calls, notes, views } = fakeDeps(['empty'])
    expect(await openInTerminal(TAB, null, 'an unknown dialog', deps)).toBe(true)
    expect(views).toEqual(['terminal'])
    expect(calls).toEqual(['view:terminal'])
    expect(notes).toEqual([])
  })

  it('a tab that closes while the wait runs: nothing is typed, and the wait ends', async () => {
    const { deps, calls, notes } = fakeDeps(['none'])
    let open = true
    deps.exists = () => open
    deps.sleep = async (ms) => {
      calls.push(`sleep:${ms}`)
      open = false
    }
    expect(await openInTerminal(TAB, '/config', '/config', deps)).toBe(false)
    expect(writes(calls)).toEqual([])
    expect(calls.filter((c) => c.startsWith('sleep:'))).toHaveLength(1)
    expect(notes).toEqual([])
  })

  it('a second command for a tab that is still waiting is refused: it types nothing', async () => {
    const { deps, calls } = fakeDeps(['none'])
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let answer: 'none' | 'empty' = 'none'
    deps.promptState = async () => answer
    deps.sleep = async (ms) => {
      calls.push(`sleep:${ms}`)
      return gate
    }
    const first = openInTerminal(TAB, '/config', '/config', deps)
    await vi.waitFor(() => expect(calls).toContain('sleep:300'))

    expect(await openInTerminal(TAB, '/cost', '/cost', deps)).toBe(false)
    answer = 'empty'
    release()
    expect(await first).toBe(true)
    expect(writes(calls)).toEqual(['write:/config', 'write:\r'])
  })

  it('a line with a control character, or no text, is refused before the switch', async () => {
    for (const line of ['/config\x1b', '/con\rfig', '/a\nb', '/a\tb', '\x7f', '']) {
      const { deps, calls } = fakeDeps(['empty'])
      expect(await openInTerminal(TAB, line, line, deps)).toBe(false)
      expect(calls).toEqual([])
    }
  })

  it('isHandoffLine takes printable text of 1 to 2000 characters, and nothing with a control character', () => {
    expect(isHandoffLine('/config')).toBe(true)
    expect(isHandoffLine('/review 日本語 a-b_c')).toBe(true)
    expect(isHandoffLine('x'.repeat(2000))).toBe(true)
    expect(isHandoffLine('x'.repeat(2001))).toBe(false)
    expect(isHandoffLine('')).toBe(false)
    for (const code of [0x00, 0x08, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f]) expect(isHandoffLine(`a${String.fromCharCode(code)}b`)).toBe(false)
  })
})
