import type { PromptState } from '../../shared/ipc'
import type { TabView } from '../../shared/chat'
import { pathKey } from '../path-key'

// The routing the chat window's calls share, kept apart from the wiring in index.ts so the tests can reach it.

export interface ChatResumeDeps {
  /** a session the app listed: its id and the folder Claude Code finds it in */
  listed(sessionId: string): { id: string; cwd: string; account?: string | null } | undefined
  tabs(): { id: string; cwd: string; claudeSessionId: string | null }[]
  /** resumes the session in the tab; false when it is refused (the tab works) */
  resume(tabId: string, sessionId: string): Promise<boolean>
  activate(tabId: string): void
  /** opens the session in a new Claude tab (on its account); false when that fails */
  open(s: { id: string; cwd: string; account?: string | null }): boolean | Promise<boolean>
}

/**
 * A session picked in a chat. The session's folder is the one the list gave, never the window's. A tab that holds the
 * session already is the one in front ('here', no restart) or is brought forward ('new-tab', as the session list does).
 * Else a session in the tab's folder resumes in the tab ('here', null when refused), and any other opens in a new tab.
 */
/**
 * Where a pick goes, without doing it: 'here' for the session the tab already holds, 'restart' for a session of the tab's own folder
 * (resumed in the tab, which restarts its process), 'new-tab' for any other (the tab that holds it is brought forward). Null when the
 * session is not listed or the tab is not there.
 */
export function planChatResume(tabId: string, sessionId: string, d: Pick<ChatResumeDeps, 'listed' | 'tabs'>): 'here' | 'restart' | 'new-tab' | null {
  const s = d.listed(sessionId)
  if (!s) return null
  const tabs = d.tabs()
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return null
  const holder = tabs.find((t) => t.claudeSessionId === s.id)
  if (holder?.id === tabId) return 'here'
  if (holder) return 'new-tab'
  return pathKey(s.cwd) === pathKey(tab.cwd) ? 'restart' : 'new-tab'
}

export async function routeChatResume(tabId: string, sessionId: string, d: ChatResumeDeps): Promise<'here' | 'new-tab' | null> {
  const s = d.listed(sessionId)
  if (!s) return null
  const tabs = d.tabs()
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return null
  const holder = tabs.find((t) => t.claudeSessionId === s.id)
  if (holder?.id === tabId) return 'here'
  if (holder) {
    d.activate(holder.id)
    return 'new-tab'
  }
  // Claude Code finds a conversation by its folder: a restart resumes it in the tab's folder
  if (pathKey(s.cwd) === pathKey(tab.cwd)) return (await d.resume(tabId, sessionId)) ? 'here' : null
  return (await d.open(s)) ? 'new-tab' : null
}

/**
 * What AutoContinue reads as the prompt of a tab. A running chat-view tab's prompt is the window's answer: its composer's
 * draft ('draft') holds the continue back, an empty composer is 'empty'. With no running chat it is 'none', so the cut-off
 * turn is reported as in the terminal. A terminal tab asks its terminal.
 */
export async function chatPromptState(view: TabView | null, running: boolean, ask: () => Promise<PromptState>): Promise<PromptState> {
  if (view === 'chat') return running ? ask() : 'none'
  return ask()
}
