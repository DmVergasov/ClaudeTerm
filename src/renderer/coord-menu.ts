import type { CoordMark } from '../shared/coordinator'

/** what the tab's context menu needs to know of a Claude tab, to say which coordinator items it offers */
export interface CoordMenuInput {
  /** a tab of another device */
  remote: boolean
  hasSession: boolean
  /** git has given this local tab a project (places.get(id)); false for a remote tab */
  hasProject: boolean
  /** the tab's own project name when known (a local tab's place, a remote tab's project), else null */
  project: string | null
  mark: CoordMark | null
  /** this device's coordinators other than this tab, in tab order */
  coordinators: { tabId: string; project: string }[]
}

export type CoordMenuAction = { kind: 'detach' } | { kind: 'stop' } | { kind: 'make' } | { kind: 'attach'; coordinatorTabId: string }

/**
 * The coordinator items of a Claude tab's context menu, the first rule that applies: an attached tab detaches (a paired device's tab only when its coordinator has a tab here); a local
 * coordinator stops; otherwise each coordinator of this device is offered (its project's first, names compared without case),
 * and a local tab with a project offers Make project coordinator after them. A paired device's tab never makes or stops a
 * coordinator: a coordinator is used from its own device's window.
 */
export function coordMenuEntries(i: CoordMenuInput): { label: string; disabled: boolean; action: CoordMenuAction }[] {
  if (i.mark?.role === 'attached') return i.remote && i.mark.coordinatorTabId === null ? [] : [{ label: `Detach from the ${i.mark.project} coordinator`, disabled: false, action: { kind: 'detach' } }]
  if (i.mark?.role === 'coordinator') return i.remote ? [] : [{ label: 'Stop coordinating', disabled: false, action: { kind: 'stop' } }]

  const sameProject = (project: string): boolean => i.project !== null && project.toLowerCase() === i.project.toLowerCase()
  const coordinators = [...i.coordinators.filter((c) => sameProject(c.project)), ...i.coordinators.filter((c) => !sameProject(c.project))]
  const attach = coordinators.map((c) => ({ label: `Attach to the ${c.project} coordinator`, disabled: !i.hasSession, action: { kind: 'attach' as const, coordinatorTabId: c.tabId } }))
  const make = i.remote || !i.hasProject ? [] : [{ label: 'Make project coordinator', disabled: !i.hasSession, action: { kind: 'make' as const } }]
  return [...attach, ...make]
}
