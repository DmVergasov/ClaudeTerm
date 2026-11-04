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
  if (from < 0 || to < 0 || dragKey === NO_PROJECT || targetKey === NO_PROJECT || from === to) return null

  const next = groups.filter((_, i) => i !== from)
  const at = next.findIndex((g) => g.key === targetKey)
  next.splice(from < to ? at + 1 : at, 0, groups[from])

  const order = panelOrder(next)
  return sameOrder(order, panelOrder(groups)) ? null : order
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
