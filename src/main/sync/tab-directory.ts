import type { RemoteTab } from '../../shared/remote'
import type { MainStatus, NotificationCase } from '../../shared/types'

// What this device tells the others about its tabs: the directory, the attention each tab waits with and the status line.

/** the longest status a RemoteTab carries (the receiving side drops an entry with a longer one) */
const MAX_STATUS = 200

/** the tabs of a device, as announced: the entries that changed since the last announcement and the tabs that closed */
export class TabDirectory {
  private readonly announced = new Map<string, string>()
  private tabs: RemoteTab[] = []

  diff(all: readonly RemoteTab[]): { changed: RemoteTab[]; closed: string[] } {
    const tabs = lastOfEach(all)
    const changed: RemoteTab[] = []
    const present = new Set<string>()
    for (const tab of tabs) {
      present.add(tab.id)
      const json = JSON.stringify(tab)
      if (this.announced.get(tab.id) === json) continue
      this.announced.set(tab.id, json)
      changed.push(tab)
    }
    const closed: string[] = []
    for (const id of this.announced.keys()) {
      if (present.has(id)) continue
      closed.push(id)
    }
    for (const id of closed) this.announced.delete(id)
    this.tabs = [...tabs]
    return { changed, closed }
  }

  all(): RemoteTab[] {
    return [...this.tabs]
  }
}

/** what a tab waits with: the reason of its latest attention, and how many attentions have started on it */
export class TabAttention {
  private readonly tabs = new Map<string, { reason: NotificationCase | null; seq: number }>()

  start(tabId: string, reason: NotificationCase): void {
    const seq = (this.tabs.get(tabId)?.seq ?? 0) + 1
    this.tabs.set(tabId, { reason, seq })
  }

  /** true when the tab had a reason */
  clear(tabId: string): boolean {
    const t = this.tabs.get(tabId)
    if (!t || t.reason === null) return false
    t.reason = null
    return true
  }

  get(tabId: string): { reason: NotificationCase | null; seq: number } {
    const t = this.tabs.get(tabId)
    return { reason: t?.reason ?? null, seq: t?.seq ?? 0 }
  }

  drop(tabId: string): void {
    this.tabs.delete(tabId)
  }
}

/** how many times the person answered each tab (typed into it, brought it to the front): a turn's end that waits for a read is answered by a change here */
export class TabInputs {
  private readonly counts = new Map<string, number>()

  bump(tabId: string): void {
    this.counts.set(tabId, this.of(tabId) + 1)
  }

  /** 0 for a tab nothing happened to */
  of(tabId: string): number {
    return this.counts.get(tabId) ?? 0
  }

  drop(tabId: string): void {
    this.counts.delete(tabId)
  }
}

/** the tabs with a repeated id once: the last entry of an id is the one kept, placed where the last one stands */
function lastOfEach(tabs: readonly RemoteTab[]): RemoteTab[] {
  const byId = new Map<string, RemoteTab>()
  for (const tab of tabs) {
    byId.delete(tab.id)
    byId.set(tab.id, tab)
  }
  return [...byId.values()]
}

// C0 and C1 control characters, DEL, and the line and paragraph separators
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/**
 * "Opus 4.1 · 42% context" (model.displayName, context.usedPct rounded), "Opus 4.1" without a context, null without a
 * status. At most MAX_STATUS characters: the model name is cut to fit, and the context stays. A name that is empty
 * after its controls are stripped is the model id, then nothing but the context; a context percentage that is not a
 * finite number is no context.
 */
export function statusSummary(main: MainStatus | null): string | null {
  if (!main) return null
  const name = main.model.displayName.replace(CONTROL_RE, '') || main.model.id.replace(CONTROL_RE, '')
  const pct = main.context && Number.isFinite(main.context.usedPct) ? `${Math.round(main.context.usedPct)}% context` : null
  if (!name) return pct
  const tail = pct === null ? '' : ` · ${pct}`
  let room = MAX_STATUS - tail.length
  let head = name.length > room ? name.slice(0, room) : name
  // never end on the high half of a surrogate pair
  if (head.length < name.length && /[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
  return head + tail
}
