import type { TabPlace } from '../shared/types'

/** The group of tabs that are not in a git repository; always the last group. */
export const NO_PROJECT = '~none'

export interface GroupInput { id: string; place: TabPlace | null; forkOf: string | null }
export interface PanelRow { id: string; fork: boolean }
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
  return sameOrder(order, panelOrder(groups)) ? null : order
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
