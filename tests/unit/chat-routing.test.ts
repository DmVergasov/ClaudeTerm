import { describe, expect, it } from 'vitest'
import { chatPromptState, planChatResume, routeChatResume, type ChatResumeDeps } from '../../src/main/chat/chat-routing'

const TAB = 'tab-1'
const OTHER = 'tab-2'
const SID = '00000000-0000-4000-8000-000000000001'
const WORK = '/work/acme'

/** the routing's dependencies as fakes: the listed session, the tabs, and a record of what was asked of them */
function deps(over: Partial<ChatResumeDeps> = {}) {
  const calls: string[] = []
  const d: ChatResumeDeps = {
    listed: (id) => (id === SID ? { id: SID, cwd: WORK } : undefined),
    tabs: () => [
      { id: TAB, cwd: WORK, claudeSessionId: null },
      { id: OTHER, cwd: WORK, claudeSessionId: null },
    ],
    resume: async (tabId, sessionId) => {
      calls.push(`resume:${tabId}:${sessionId}`)
      return true
    },
    activate: (tabId) => calls.push(`activate:${tabId}`),
    open: (s) => {
      calls.push(`open:${s.id}:${s.cwd}`)
      return true
    },
    ...over,
  }
  return { d, calls }
}

describe('planChatResume', () => {
  it('says where a pick goes, without doing it: here, a restart in the tab, or a new tab', () => {
    const plan = (over: Partial<ChatResumeDeps>) => {
      const { d, calls } = deps(over)
      const where = planChatResume(TAB, SID, d)
      expect(calls).toEqual([])
      return where
    }
    expect(plan({ listed: () => undefined })).toBeNull()
    expect(plan({ tabs: () => [{ id: TAB, cwd: WORK, claudeSessionId: SID }] })).toBe('here')
    expect(plan({ tabs: () => [{ id: TAB, cwd: WORK, claudeSessionId: null }, { id: OTHER, cwd: WORK, claudeSessionId: SID }] })).toBe('new-tab')
    expect(plan({})).toBe('restart')
    expect(plan({ listed: () => ({ id: SID, cwd: '/elsewhere' }) })).toBe('new-tab')
  })
})

describe('routeChatResume', () => {
  it('an unknown session is refused, and nothing is asked', async () => {
    const { d, calls } = deps()
    expect(await routeChatResume(TAB, 'no-such-session', d)).toBeNull()
    expect(calls).toEqual([])
  })

  it('a tab that is not there is refused', async () => {
    const { d, calls } = deps({ tabs: () => [{ id: OTHER, cwd: WORK, claudeSessionId: null }] })
    expect(await routeChatResume(TAB, SID, d)).toBeNull()
    expect(calls).toEqual([])
  })

  it('the tab that already holds the session stays as it is: here, with no restart', async () => {
    const { d, calls } = deps({ tabs: () => [{ id: TAB, cwd: WORK, claudeSessionId: SID }] })
    expect(await routeChatResume(TAB, SID, d)).toBe('here')
    expect(calls).toEqual([])
  })

  it('another tab that holds the session is brought forward, and the answer is new-tab, with no second tab', async () => {
    const { d, calls } = deps({ tabs: () => [{ id: TAB, cwd: WORK, claudeSessionId: null }, { id: OTHER, cwd: WORK, claudeSessionId: SID }] })
    expect(await routeChatResume(TAB, SID, d)).toBe('new-tab')
    expect(calls).toEqual([`activate:${OTHER}`])
  })

  it('a session in the tab\'s folder resumes in the tab: here', async () => {
    const { d, calls } = deps()
    expect(await routeChatResume(TAB, SID, d)).toBe('here')
    expect(calls).toEqual([`resume:${TAB}:${SID}`])
  })

  it('a session the tab cannot resume (it works) is refused: null, and no new tab', async () => {
    const { d, calls } = deps({ resume: async () => false })
    expect(await routeChatResume(TAB, SID, d)).toBeNull()
    expect(calls).toEqual([])
  })

  it('a session in another folder opens in a new tab, as the session list opens it', async () => {
    const { d, calls } = deps({ listed: () => ({ id: SID, cwd: '/elsewhere/project' }) })
    expect(await routeChatResume(TAB, SID, d)).toBe('new-tab')
    expect(calls).toEqual([`open:${SID}:/elsewhere/project`])
  })

  it('the folder of the session is the listed one: the answer comes from the list, not from what the window says', async () => {
    const { d, calls } = deps({ listed: () => ({ id: SID, cwd: '/elsewhere/project' }) })
    await routeChatResume(TAB, SID, d)
    expect(calls.some((c) => c.startsWith('resume:'))).toBe(false)
  })

  it('a session in another folder whose tab cannot open is refused', async () => {
    const { d, calls } = deps({ listed: () => ({ id: SID, cwd: '/elsewhere/project' }), open: () => false })
    expect(await routeChatResume(TAB, SID, d)).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('chatPromptState', () => {
  it('a chat-view tab with a running chat asks the window, and a draft in its composer holds the continue back', async () => {
    let asked = 0
    expect(await chatPromptState('chat', true, async () => ((asked++), 'draft'))).toBe('draft')
    expect(asked).toBe(1)
  })

  it('a chat-view tab with a running chat and an empty composer answers empty', async () => {
    expect(await chatPromptState('chat', true, async () => 'empty')).toBe('empty')
  })

  it('a chat-view tab whose chat has ended answers none, so the cut-off turn is notified as in the terminal', async () => {
    let asked = 0
    expect(await chatPromptState('chat', false, async () => ((asked++), 'empty'))).toBe('none')
    expect(asked).toBe(0)
  })

  it('a terminal tab asks the terminal', async () => {
    expect(await chatPromptState('terminal', false, async () => 'draft')).toBe('draft')
  })
})
