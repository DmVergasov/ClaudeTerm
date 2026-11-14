import { describe, expect, it } from 'vitest'
import { ViewFollow, type FollowedTab } from '../../src/main/view-follow'
import type { TabView } from '../../src/shared/chat'

/** the follower with fake tabs: the test sets the setting, the tabs and their background tasks, and reads the switches asked */
function harness(tabs: FollowedTab[], refuse: string[] = []) {
  const h = { home: 'chat' as TabView, tabs, background: new Map<string, number>(), asked: [] as [string, TabView][] }
  const follow = new ViewFollow({
    home: () => h.home,
    tabs: () => h.tabs,
    background: (id) => h.background.get(id) ?? 0,
    setView: async (id, view) => {
      h.asked.push([id, view])
      if (refuse.includes(id)) return false
      h.tabs = h.tabs.map((t) => (t.id === id ? { ...t, view } : t))
      return true
    }
  })
  return { h, follow }
}

const claude = (id: string, view: TabView, over: Partial<FollowedTab> = {}): FollowedTab => ({ id, kind: 'claude', view, activity: null, exited: false, ...over })
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('ViewFollow', () => {
  it('a change of the setting switches every idle Claude tab in another view, and leaves shell tabs and tabs already there', async () => {
    const { h, follow } = harness([claude('a', 'chat'), claude('b', 'chat'), claude('c', 'terminal'), { id: 's', kind: 'shell', view: null, activity: null, exited: false }])
    h.home = 'terminal'
    follow.settingChanged()
    await flush()
    expect(h.asked).toEqual([['a', 'terminal'], ['b', 'terminal']])
  })

  it('a tab that works switches once its answer ends, and only once', async () => {
    const { h, follow } = harness([claude('a', 'chat', { activity: 'working' })])
    h.home = 'terminal'
    follow.settingChanged()
    await flush()
    expect(h.asked).toEqual([])
    follow.updated(claude('a', 'chat', { activity: 'working' }))
    await flush()
    expect(h.asked).toEqual([])
    h.tabs = [claude('a', 'chat')]
    follow.updated(h.tabs[0])
    await flush()
    expect(h.asked).toEqual([['a', 'terminal']])
    follow.updated(claude('a', 'terminal'))
    await flush()
    expect(h.asked).toEqual([['a', 'terminal']])
  })

  it('a working tab is not switched when the setting went back before its answer ended', async () => {
    const { h, follow } = harness([claude('a', 'chat', { activity: 'working' })])
    h.home = 'terminal'
    follow.settingChanged()
    h.home = 'chat'
    follow.settingChanged()
    h.tabs = [claude('a', 'chat')]
    follow.updated(h.tabs[0])
    await flush()
    expect(h.asked).toEqual([])
  })

  it('a tab with background tasks keeps its view, now and when its answer ends: a switch would stop them', async () => {
    const { h, follow } = harness([claude('a', 'chat'), claude('b', 'chat', { activity: 'working' })])
    h.background.set('a', 1)
    h.background.set('b', 2)
    h.home = 'terminal'
    follow.settingChanged()
    h.tabs = [claude('a', 'chat'), claude('b', 'chat')]
    follow.updated(h.tabs[1])
    await flush()
    expect(h.asked).toEqual([])
  })

  it('an exited tab is left alone, and a closed one is forgotten', async () => {
    const { h, follow } = harness([claude('a', 'chat', { exited: true }), claude('b', 'chat', { activity: 'working' })])
    h.home = 'terminal'
    follow.settingChanged()
    follow.removeTab('b')
    follow.updated(claude('b', 'chat'))
    await flush()
    expect(h.asked).toEqual([])
  })
})
