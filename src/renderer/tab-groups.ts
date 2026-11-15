import type { CoordMark } from '../shared/coordinator'
import type { TabPlace } from '../shared/types'

/** The group of tabs that are not in a git repository; always the last group. */
export const NO_PROJECT = '~none'

export interface GroupInput { id: string; place: TabPlace | null; forkOf: string | null }
/** a tab as the left panel reads it: a GroupInput with its device (null: this device's own tab) and its part in a coordinator */
export interface PanelItem extends GroupInput { group: string | null; coord: CoordMark | null }
export interface PanelRow {
  id: string; fork: boolean
  /** the row stands in a coordinator's block: the coordinator's tab id; absent outside one */
  block?: string
  /** a row of the block other than the coordinator's family: an attached session (or a fork of one), drawn indented */
  attached?: true
  /** a paired device's session shown in its coordinator's block: its device owns its order, and it is not in its device's section */
  pulled?: true
}
export interface PanelGroup { key: string; project: TabPlace['project'] | null; rows: PanelRow[] }

/**
 * The left panel's groups. Groups come in the order of their first tab, `NO_PROJECT` last; rows keep the tab
 * order, except that a fork stands right after its head and the head's earlier forks. A fork whose head is
 * missing from its group (closed, or in another group) is an ordinary row.
 */
export function panelGroups(tabs: GroupInput[]): PanelGroup[] {
  const members = new Map<string, GroupInput[]>()
  for (const tab of tabs) {
    const key = tab.place?.project.key ?? NO_PROJECT
    members.set(key, [...(members.get(key) ?? []), tab])
  }
  const keys = [...members.keys()].sort((a, b) => Number(a === NO_PROJECT) - Number(b === NO_PROJECT))

  return keys.map((key) => {
    const list = members.get(key) ?? []
    const heads = new Set(list.filter((tab) => tab.forkOf === null).map((tab) => tab.id))
    const forks = new Map<string, GroupInput[]>()
    for (const tab of list) {
      if (tab.forkOf === null || !heads.has(tab.forkOf)) continue
      forks.set(tab.forkOf, [...(forks.get(tab.forkOf) ?? []), tab])
    }

    const rows: PanelRow[] = []
    for (const tab of list) {
      if (tab.forkOf !== null && heads.has(tab.forkOf)) continue
      rows.push({ id: tab.id, fork: false })
      for (const fork of forks.get(tab.id) ?? []) rows.push({ id: fork.id, fork: true })
    }
    return { key, project: list[0].place?.project ?? null, rows }
  })
}

/** The tab ids of all groups, in panel order. */
export function panelOrder(groups: PanelGroup[]): string[] {
  return groups.flatMap((group) => group.rows.map((row) => row.id))
}

/**
 * The tab order to send to main after the left panel was rendered, or null when nothing is to be sent. Nothing is sent
 * while a tab's place is unknown: its group is then only a guess (No project), and the order main keeps would follow it.
 */
export function orderToWrite(order: string[], visualOrder: string[], placesKnown: boolean): string[] | null {
  if (!placesKnown || sameOrder(order, visualOrder)) return null
  return visualOrder
}

/** Each row that is not a fork starts a block; the forks after it belong to that block. */
function blocksOf(rows: PanelRow[]): string[][] {
  const blocks: string[][] = []
  for (const row of rows) {
    if (row.fork) blocks[blocks.length - 1].push(row.id)
    else blocks.push([row.id])
  }
  return blocks
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * The new tab order after dragging `dragId` onto `targetId`, or null when nothing changes or the drop is not
 * allowed. A fork stays in its family and takes the target's place among the forks (the head is place 0).
 * A tab moves down after the target's family and up before it, with its own forks.
 */
export function moveTab(groups: PanelGroup[], dragId: string, targetId: string): string[] | null {
  const group = groups.find((g) => g.rows.some((r) => r.id === dragId))
  if (!group || dragId === targetId) return null
  const drag = group.rows.find((r) => r.id === dragId)
  const target = group.rows.find((r) => r.id === targetId)
  if (!drag || !target) return null

  const blocks = blocksOf(group.rows)
  if (drag.fork) {
    const block = blocks.find((b) => b.includes(dragId))
    if (!block || !block.includes(targetId)) return null
    const forks = block.slice(1)
    const from = forks.indexOf(dragId)
    const to = targetId === block[0] ? 0 : forks.indexOf(targetId)
    const [moved] = forks.splice(from, 1)
    forks.splice(to, 0, moved)
    blocks[blocks.indexOf(block)] = [block[0], ...forks]
  } else {
    if (target.fork) return null
    const [moving] = blocks.splice(blocks.findIndex((b) => b[0] === dragId), 1)
    const at = blocks.findIndex((b) => b[0] === targetId)
    const down = group.rows.indexOf(drag) < group.rows.indexOf(target)
    blocks.splice(down ? at + 1 : at, 0, moving)
  }

  const next = groups.flatMap((g) => (g === group ? blocks.flat() : g.rows.map((r) => r.id)))
  return sameOrder(next, panelOrder(groups)) ? null : next
}

/**
 * The new tab order after dragging group `dragKey` onto group `targetKey`, or null when nothing changes.
 * The group moves after its target when moving down and before it when moving up. The No project group
 * never moves, and nothing moves after it.
 */
export function moveGroup(groups: PanelGroup[], dragKey: string, targetKey: string): string[] | null {
  const from = groups.findIndex((g) => g.key === dragKey)
  const to = groups.findIndex((g) => g.key === targetKey)
  // the No project group is the one without a project, whatever key its section gives it
  if (from < 0 || to < 0 || groups[from].project === null || groups[to].project === null || from === to) return null

  const next = groups.filter((_, i) => i !== from)
  const at = next.findIndex((g) => g.key === targetKey)
  next.splice(from < to ? at + 1 : at, 0, groups[from])

  const order = panelOrder(next)
  return sameOrder(order, panelOrder(groups)) ? null : withoutPulled(order, groups)
}

/**
 * The fold key of a project group in another device's section. It is apart from the same project's group on this
 * device and on any other device, so a fold of one never folds another.
 */
export function deviceGroupKey(device: string, projectKey: string): string {
  return `${device}\n${projectKey}`
}

/** A device's section: its tabs grouped by project, as panelGroups groups this device's own, under deviceGroupKey keys. */
export function deviceGroups(device: string, tabs: GroupInput[]): PanelGroup[] {
  return panelGroups(tabs).map((group) => ({ ...group, key: deviceGroupKey(device, group.key) }))
}

/**
 * The order of a device's tabs on the tab bar. A group this window dragged keeps the drag's order, and the tabs that
 * came since follow in arrival order. A group never dragged puts each fork right after its family: after the head and
 * the forks that came before it. A fork whose head is not in the list is an ordinary tab, in its arrival place.
 */
export function tabBarOrder(tabs: { id: string; forkOf: string | null }[], dragged: string[]): string[] {
  const ids = tabs.map((tab) => tab.id)
  const kept = dragged.filter((id) => ids.includes(id))
  const isFork = (tab: { id: string; forkOf: string | null }): boolean => tab.forkOf !== null && tab.forkOf !== tab.id && ids.includes(tab.forkOf)
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))

  // the number of forks above a fork in its chain; a cycle of forks has no head, and its depth is infinite
  const depthOf = (tab: { id: string; forkOf: string | null }): number => {
    let depth = 0
    let at: { id: string; forkOf: string | null } | undefined = tab
    const seen = new Set<string>()
    while (at !== undefined && isFork(at)) {
      if (seen.has(at.id)) return Infinity
      seen.add(at.id)
      depth++
      at = byId.get(at.forkOf!)
    }
    return depth
  }
  // a head and every fork under it, at any depth
  const familyOf = (head: string): Set<string> => {
    const family = new Set([head])
    for (let grew = true; grew; ) {
      grew = false
      for (const tab of tabs) {
        if (tab.forkOf !== null && family.has(tab.forkOf) && !family.has(tab.id)) {
          family.add(tab.id)
          grew = true
        }
      }
    }
    return family
  }

  // the dragged tabs keep the drag's order; the others follow in arrival order, the forks not yet placed among them
  const order = [...kept, ...tabs.filter((tab) => !kept.includes(tab.id) && !isFork(tab)).map((tab) => tab.id)]
  // a fork not dragged goes right after its family's last tab. Parents come first, so a fork of a fork lands after its own parent
  const forks = tabs
    .filter((tab) => !kept.includes(tab.id) && isFork(tab))
    .map((tab) => ({ id: tab.id, forkOf: tab.forkOf!, depth: depthOf(tab) }))
    .sort((a, b) => a.depth - b.depth)
  for (const fork of forks) {
    if (fork.depth === Infinity) continue
    const family = familyOf(fork.forkOf)
    let last = order.indexOf(fork.forkOf)
    order.forEach((id, i) => { if (family.has(id)) last = i })
    order.splice(last + 1, 0, fork.id)
  }
  // a cycle of forks has no head: its tabs keep their arrival order, at the end
  for (const fork of forks) if (fork.depth === Infinity) order.push(fork.id)
  return order
}

/** Each group's label: its project's name, with the parent folder when another project has the same name. */
export function groupLabels(groups: PanelGroup[]): Map<string, string> {
  const nameCount = new Map<string, number>()
  for (const group of groups) {
    if (group.project) nameCount.set(group.project.name, (nameCount.get(group.project.name) ?? 0) + 1)
  }

  const labels = new Map<string, string>()
  for (const group of groups) {
    const project = group.project
    if (!project) labels.set(group.key, 'No project')
    else if ((nameCount.get(project.name) ?? 0) > 1) labels.set(group.key, `${project.name} (${project.parent})`)
    else labels.set(group.key, project.name)
  }
  return labels
}

/** The tab bar names its groups only when there are several: one project (or only tabs outside git) needs no label. */
export const showsGroupLabels = (groups: PanelGroup[]): boolean => groups.length > 1

/**
 * The tab bar's groups: panelGroups' groups, but each group's rows keep the order the tabs have (`tabs`, in their order).
 * A fork the user put before its head stays there; panelGroups would move it after the head.
 */
export function storedGroups(tabs: GroupInput[]): PanelGroup[] {
  return panelGroups(tabs).map((group) => {
    const rows = new Map(group.rows.map((row) => [row.id, row]))
    return { ...group, rows: tabs.flatMap((tab) => rows.get(tab.id) ?? []) }
  })
}

/**
 * The tab order after dragging `dragId` onto `targetId` in the tab bar, or null when nothing changes. Both must be in the
 * same group, as the groups in `storedGroups` show them: a tab moves down after its target and up before it, a fork
 * included, and the other tabs keep their place. Dropping a tab on itself, or across groups, moves nothing.
 */
export function moveInGroup(groups: PanelGroup[], dragId: string, targetId: string): string[] | null {
  if (dragId === targetId) return null
  const group = groups.find((g) => g.rows.some((r) => r.id === dragId))
  if (!group || !group.rows.some((r) => r.id === targetId)) return null

  const ids = group.rows.map((r) => r.id)
  const from = ids.indexOf(dragId)
  const to = ids.indexOf(targetId)
  ids.splice(from, 1)
  const at = ids.indexOf(targetId)
  ids.splice(from < to ? at + 1 : at, 0, dragId)

  const next = groups.flatMap((g) => (g === group ? ids : g.rows.map((r) => r.id)))
  return sameOrder(next, panelOrder(groups)) ? null : next
}

/** the coordinator chip on a project group's header: `running` names the coordinator's tab (brought to the front), `start` the tab a new coordinator is started from */
export type GroupChip = { kind: 'running'; tabId: string } | { kind: 'start'; tabId: string }

/**
 * The chip on a group's header: none (null) for a group of another device, and for No project. `running` when one of the group's
 * tabs is this device's coordinator (its mark has role 'coordinator'); a pulled row is never the coordinator of this device, and
 * never the tab a start is asked from. Otherwise `start`, from the group's first row that is not pulled; null when no row is.
 */
export function groupChip(group: PanelGroup, own: boolean, coordOf: (id: string) => CoordMark | null): GroupChip | null {
  if (!own || group.project === null) return null
  const rows = group.rows.filter((row) => !row.pulled)
  const coordinator = rows.find((row) => coordOf(row.id)?.role === 'coordinator')
  if (coordinator) return { kind: 'running', tabId: coordinator.id }
  return rows.length > 0 ? { kind: 'start', tabId: rows[0].id } : null
}

/**
 * Each group that holds a coordinator (a row whose mark is { role: 'coordinator' }): the units whose first row is attached to
 * it (mark { role: 'attached', coordinatorTabId: <its id> }) move right after the coordinator's unit, in their order; the
 * coordinator's unit gets `block`, the moved units `block` and `attached`. A unit is a row and the fork rows after it when
 * `families` (the left panel), a single row otherwise (the tab bar). A group without a coordinator is returned as it is.
 */
export function arrangeCoordinators(groups: PanelGroup[], coordOf: (id: string) => CoordMark | null, families: boolean): PanelGroup[] {
  return groups.map((group) => {
    const units = unitsOf(group.rows, families)
    const markOf = (unit: PanelRow[]): CoordMark | null => coordOf(unit[0].id)
    const coordinators = units.filter((unit) => markOf(unit)?.role === 'coordinator')
    if (coordinators.length === 0) return group

    const moved = new Set<PanelRow[]>()
    const attachedTo = new Map<PanelRow[], PanelRow[][]>()
    for (const coordinator of coordinators) {
      const attached = units.filter((unit) => {
        const mark = markOf(unit)
        return !moved.has(unit) && mark?.role === 'attached' && mark.coordinatorTabId === coordinator[0].id
      })
      for (const unit of attached) moved.add(unit)
      attachedTo.set(coordinator, attached)
    }

    const rows: PanelRow[] = units.flatMap((unit) => {
      if (moved.has(unit)) return []
      const attached = attachedTo.get(unit)
      if (!attached) return unit
      const block = unit[0].id
      return [
        ...unit.map((row) => ({ ...row, block })),
        ...attached.flatMap((family) => family.map((row) => ({ ...row, block, attached: true as const })))
      ]
    })
    return { ...group, rows }
  })
}

/** what a drop needs to know of a row: Claude or shell, this device's, its mark, the block it stands in (its PanelRow's block) */
export interface DropRow { id: string; claude: boolean; local: boolean; coord: CoordMark | null; block: string | null }
export type PanelDrop =
  | { kind: 'attach'; coordinator: string; tab: string }
  | { kind: 'detach'; coordinator: string; tab: string; order: string[] | null }
  | { kind: 'reorder'; order: string[] }

/** a Claude tab, of this device or a paired one, no coordinator itself, dropped on another tab that is a coordinator it is not attached to (one attached to another coordinator is asked for too: main answers with the refusal, and the hub decides for a tab of another device) */
export function dropAttaches(drag: DropRow, target: DropRow): boolean {
  if (!drag.claude || drag.coord?.role === 'coordinator' || target.coord?.role !== 'coordinator') return false
  return !(drag.coord?.role === 'attached' && drag.coord.coordinatorTabId === target.id)
}

/** whether an attached tab's header shows Detach: a tab of this device always (it leaves through coordLeave, on any device); a paired device's tab only when its coordinator has an open tab here, the row Detach names */
export function headerDetachShown(group: string | null, coordinatorTabId: string | null): boolean {
  return group === null || coordinatorTabId !== null
}

/**
 * What a row dropped on another row of the left panel does; null: nothing. `groups`: the target's section, arranged.
 * In order: the same row → null; the target is a coordinator → attach when dropAttaches, else null; the dragged row is an
 * attached session standing in its coordinator's block and the target is outside that block → detach, with moveTab's order
 * (null across groups, and null for a paired device's row, whose order is its device's); the target is in a block the dragged
 * row is not in, or the dragged row is a coordinator and the target is in its own block → null; a paired device's row inside
 * its block → null; else moveTab's order as a reorder, without the pulled rows (null when it gives none).
 */
export function panelDrop(groups: PanelGroup[], drag: DropRow, target: DropRow): PanelDrop | null {
  if (drag.id === target.id) return null
  if (target.coord?.role === 'coordinator') return dropAttaches(drag, target) ? { kind: 'attach', coordinator: target.id, tab: drag.id } : null
  if (drag.block !== null && drag.coord?.role === 'attached' && target.block !== drag.block) {
    const order = drag.local ? moveTab(groups, drag.id, target.id) : null
    return { kind: 'detach', coordinator: drag.block, tab: drag.id, order: order && withoutPulled(order, groups) }
  }
  if (target.block !== null && (target.block !== drag.block || drag.coord?.role === 'coordinator')) return null
  if (!drag.local && drag.block !== null) return null
  const order = moveTab(groups, drag.id, target.id)
  return order ? { kind: 'reorder', order: withoutPulled(order, groups) } : null
}

/**
 * What a row dropped in the left panel off the rows (on the list's free space or a group's header) does; null: nothing.
 * `groups`: the dragged row's section, arranged. Only an attached session standing in its coordinator's block does something:
 * it is detached, and goes with its forks to the end of its group, an order without the pulled rows. A paired device's row
 * gets no order, as its device keeps it, and nor does a fork, which stays in its family.
 */
export function panelDropOut(groups: PanelGroup[], drag: DropRow): PanelDrop | null {
  if (drag.block === null || drag.coord?.role !== 'attached') return null
  const group = groups.find((g) => g.rows.some((r) => r.id === drag.id && !r.fork))
  if (!drag.local || !group) return { kind: 'detach', coordinator: drag.block, tab: drag.id, order: null }
  const blocks = blocksOf(group.rows)
  const [moving] = blocks.splice(blocks.findIndex((b) => b[0] === drag.id), 1)
  const order = groups.flatMap((g) => (g === group ? [...blocks.flat(), ...moving] : g.rows.map((r) => r.id)))
  return { kind: 'detach', coordinator: drag.block, tab: drag.id, order: withoutPulled(order, groups) }
}

/**
 * The coordinator a tab is pulled into: its mark names a coordinator that is a tab of this device (`localIds`), so the left
 * panel shows the tab in that coordinator's block. Null when it is not pulled.
 */
export function pulledBy(coord: CoordMark | null, localIds: ReadonlySet<string>): string | null {
  return coord?.role === 'attached' && coord.coordinatorTabId !== null && localIds.has(coord.coordinatorTabId) ? coord.coordinatorTabId : null
}

/**
 * Puts the pulled rows into their coordinator's block: after the block's last row, in the order given, each marked `attached`
 * and `pulled`. A row whose coordinator stands in no group is not placed.
 */
export function placePulled(groups: PanelGroup[], pulled: { id: string; coordinatorTabId: string }[]): PanelGroup[] {
  return groups.map((group) => {
    const rows = [...group.rows]
    for (const { id, coordinatorTabId } of pulled) {
      const coordinator = rows.findIndex((r) => r.id === coordinatorTabId)
      if (coordinator < 0) continue
      let last = coordinator
      rows.forEach((r, i) => { if (r.block === coordinatorTabId) last = i })
      rows.splice(last + 1, 0, { id, fork: false, block: coordinatorTabId, attached: true, pulled: true })
    }
    return rows.length === group.rows.length ? group : { ...group, rows }
  })
}

/** an order without the pulled rows of the groups: a paired device's session shown in a block is ordered by its device, not here */
export function withoutPulled(order: string[], groups: PanelGroup[]): string[] {
  const pulled = new Set(groups.flatMap((g) => g.rows.filter((r) => r.pulled).map((r) => r.id)))
  return order.filter((id) => !pulled.has(id))
}

/** this device's tab ids in the order the panel shows them: panelOrder without the pulled rows, the order main is given */
export function panelOwnOrder(groups: PanelGroup[]): string[] {
  return withoutPulled(panelOrder(groups), groups)
}

/** one part of the left panel: this device's groups (device null), or a device's section with its groups */
export interface PanelSection<D> { device: D | null; groups: PanelGroup[] }

/**
 * The keyboard's walk over the device sections, in the devices' order: a device's section ids, unless the device is folded,
 * then its pulled rows (`pulled`: the rows shown in this device's blocks, each with its device). The fold gates only the
 * section: a pulled row is drawn in a block outside the folded section, so it is still reached.
 */
export function panelDeviceOrder<D extends { id: string }>(devices: D[], sections: PanelSection<D>[], pulled: { id: string; device: string }[], folded: ReadonlySet<string>): string[] {
  return devices.flatMap((device) => {
    const section = sections.find((s) => s.device?.id === device.id)
    return [
      ...(section && !folded.has(device.id) ? panelOrder(section.groups) : []),
      ...pulled.filter((p) => p.device === device.id).map((p) => p.id)
    ]
  })
}

/**
 * The left panel's parts in the order it shows them: this device's groups, arranged by coordinator, with each paired device's
 * session attached to a coordinator of this device pulled into that block; then a section for each device that has tabs left
 * to show or is online. A pulled tab is in no device section, so a device whose tabs are all pulled and that is offline has no
 * section.
 */
export function panelSections<D extends { id: string; online: boolean }>(items: PanelItem[], devices: D[]): PanelSection<D>[] {
  const localIds = new Set(items.filter((item) => item.group === null).map((item) => item.id))
  const coordOf = new Map<string, CoordMark | null>(items.map((item): [string, CoordMark | null] => [item.id, item.coord]))
  const arranged = (groups: PanelGroup[]): PanelGroup[] => arrangeCoordinators(groups, (id) => coordOf.get(id) ?? null, true)

  const pulled = items.flatMap((item) => {
    const coordinatorTabId = item.group === null ? null : pulledBy(item.coord, localIds)
    return coordinatorTabId === null ? [] : [{ id: item.id, coordinatorTabId }]
  })
  const pulledIds = new Set(pulled.map((p) => p.id))
  const own = placePulled(arranged(panelGroups(items.filter((item) => item.group === null))), pulled)
  const sections = devices.flatMap((device): PanelSection<D>[] => {
    const tabs = items.filter((item) => item.group === device.id && !pulledIds.has(item.id))
    return tabs.length === 0 && !device.online ? [] : [{ device, groups: arranged(deviceGroups(device.id, tabs)) }]
  })
  return [{ device: null, groups: own }, ...sections]
}

/** a group's units: a row that is not a fork starts one, and with `families` the fork rows after it join it; each row alone otherwise */
function unitsOf(rows: PanelRow[], families: boolean): PanelRow[][] {
  const units: PanelRow[][] = []
  for (const row of rows) {
    const last = units[units.length - 1]
    if (families && row.fork && last !== undefined && !last[0].fork) last.push(row)
    else units.push([row])
  }
  return units
}
