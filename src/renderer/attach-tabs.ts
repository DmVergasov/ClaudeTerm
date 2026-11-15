import type { AttachTab } from './sessions-model'

/** what the window knows of a tab for the attach rules: its kind, its session and place, and the paired device it runs on */
export interface AttachableTab {
  id: string
  title: string
  kind: string
  claudeSessionId: string | null
  exited: boolean
  folder: string
  branch: string | null
  /** the paired device the tab runs on, its name and whether it is online; null for a tab of this device */
  device: { name: string; online: boolean } | null
}

/** a tab dropped on a coordinator's Sessions panel attaches when it is a Claude tab other than the coordinator, of this device or a paired one: the hub decides */
export function canAttachTo(coordinatorTabId: string, tabId: string, tab: { kind: string } | undefined): boolean {
  return tabId !== coordinatorTabId && tab !== undefined && tab.kind === 'claude'
}

/** every tab as Attach… reads it: a Claude tab's session, its folder and its branch; a tab of an offline device is left out, as it takes no input */
export function attachTabsOf(tabs: AttachableTab[]): AttachTab[] {
  return tabs.flatMap((t): AttachTab[] => {
    if (t.device !== null && !t.device.online) return []
    return [{ id: t.id, title: t.title, claude: t.kind === 'claude', device: t.device?.name ?? null, session: t.claudeSessionId, exited: t.exited, folder: t.folder, branch: t.branch }]
  })
}
