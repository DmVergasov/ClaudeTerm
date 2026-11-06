import { taskListStatus, type TaskList } from '../shared/task-list'
import type { PlanStatus } from '../shared/types'
import type { TaskListStore } from './task-list-store'

export interface TaskListHubDeps {
  store: Pick<TaskListStore, 'get' | 'set'>
  /** the tab's status bar list changed */
  onChange(tabId: string): void
}

interface TabList {
  sessionId: string | null
  /** the list of a tab with no conversation yet; it moves to the store with the first id */
  list: TaskList | null
  /** the session ended: the list stays stored but is not shown */
  hidden: boolean
}

const copyList = (list: TaskList): TaskList => ({ title: list.title, tasks: list.tasks.map((task) => ({ ...task })) })

/** Each Claude tab's task list: kept with the tab's conversation, and moved or copied when the conversation changes. */
export class TaskListHub {
  private readonly tabs = new Map<string, TabList>()

  constructor(private readonly deps: TaskListHubDeps) {}

  addTab(tabId: string, sessionId: string | null): void {
    const before = this.statusJson(tabId)
    this.tabs.set(tabId, { sessionId, list: null, hidden: false })
    this.notify(tabId, before)
  }

  /** Forgets the tab; the list stays stored under the tab's last conversation. */
  removeTab(tabId: string): void {
    this.tabs.delete(tabId)
  }

  /**
   * The tab's conversation changed (/clear, /resume, a fork, a first id). `forkFrom` is the conversation a fork
   * started from, if it is one.
   */
  session(tabId: string, sessionId: string, forkFrom: string | null): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const before = this.statusJson(tabId)
    if (tab.sessionId === sessionId) {
      tab.hidden = false
    } else {
      this.enter(tab, sessionId, forkFrom)
    }
    this.notify(tabId, before)
  }

  /** The tab's session ended: its list is hidden, kept stored. */
  sessionEnd(tabId: string, sessionId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.sessionId !== sessionId) return
    const before = this.statusJson(tabId)
    tab.hidden = true
    this.notify(tabId, before)
  }

  /** Stores the list under the tab's conversation, or holds it in the tab until the first id; null removes it. */
  set(tabId: string, list: TaskList | null): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    const before = this.statusJson(tabId)
    if (tab.sessionId) this.deps.store.set(tab.sessionId, list ? copyList(list) : null)
    else tab.list = list ? copyList(list) : null
    this.notify(tabId, before)
    return true
  }

  get(tabId: string): TaskList | null {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.hidden) return null
    const list = tab.sessionId ? this.deps.store.get(tab.sessionId) : tab.list
    return list ? copyList(list) : null
  }

  status(tabId: string): PlanStatus | null {
    const list = this.get(tabId)
    return list ? taskListStatus(list) : null
  }

  /**
   * The tab takes a new conversation. Its own stored list shows; else a fork copies the list of the conversation it
   * forked from; else the tab's list moves to the new id: an unfinished one from the old conversation, or the list
   * the tab held before its first id, finished or not. A finished list stays with the old conversation, and the tab
   * shows none.
   */
  private enter(tab: TabList, sessionId: string, forkFrom: string | null): void {
    const old = tab.sessionId
    const own = this.deps.store.get(sessionId)
    const source = !own && forkFrom ? this.deps.store.get(forkFrom) : null
    const current = old ? this.deps.store.get(old) : tab.list
    if (!own && source) this.deps.store.set(sessionId, source)
    else if (!own && current && (!old || !taskListStatus(current).finished)) {
      this.deps.store.set(sessionId, current)
      if (old) this.deps.store.set(old, null)
    }
    tab.sessionId = sessionId
    tab.list = null
    tab.hidden = false
  }

  private statusJson(tabId: string): string {
    return JSON.stringify(this.status(tabId))
  }

  private notify(tabId: string, before: string): void {
    if (this.statusJson(tabId) !== before) this.deps.onChange(tabId)
  }
}

/**
 * What the status bar shows of a tab's superpowers plan and task list: an unfinished plan wins; a finished plan
 * gives way to an unfinished list (the agent's own list, `agentList`); with both finished, the one that finished
 * later shows: `newer` names the side whose status changed last.
 */
export function shownPlan(
  plan: PlanStatus | null,
  list: PlanStatus | null,
  newer: 'plan' | 'list'
): { plan: PlanStatus | null; agentList: boolean } {
  if (!list) return { plan, agentList: false }
  if (!plan) return { plan: list, agentList: true }
  if (!plan.finished) return { plan, agentList: false }
  if (!list.finished) return { plan: list, agentList: true }
  return newer === 'list' ? { plan: list, agentList: true } : { plan, agentList: false }
}
