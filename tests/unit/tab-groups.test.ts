import { describe, expect, it } from 'vitest'
import {
  NO_PROJECT,
  arrangeCoordinators,
  deviceGroups,
  dropAttaches,
  groupChip,
  groupLabels,
  placePulled,
  pulledBy,
  withoutPulled,
  headerDetachShown,
  moveGroup,
  moveTab,
  orderToWrite,
  panelDrop,
  panelDropOut,
  panelGroups,
  panelOrder,
  showsGroupLabels,
  moveInGroup,
  storedGroups,
  type DropRow,
  type GroupInput,
  type PanelGroup
} from '../../src/renderer/tab-groups'
import type { TabPlace } from '../../src/shared/types'
import type { CoordMark } from '../../src/shared/coordinator'

function place(path: string, parent = 'w'): TabPlace {
  return {
    project: { key: path.toLowerCase(), name: path.split('/').pop() ?? path, parent },
    worktree: null,
    branch: 'main'
  }
}

const tab = (id: string, p: TabPlace | null, forkOf: string | null = null): GroupInput => ({ id, place: p, forkOf })

const acme = place('C:/w/acme')
const blog = place('C:/w/blog')
const cafe = place('C:/w/cafe')

/** The rows of one group as readable strings: `A` or `A1 (fork)`. */
function rows(group: PanelGroup): string[] {
  return group.rows.map((r) => (r.fork ? `${r.id} (fork)` : r.id))
}

describe('panel groups', () => {
  it('groups tabs by project in the order of their first tab, with tabs outside git last', () => {
    const groups = panelGroups([
      tab('A', acme),
      tab('N', null),
      tab('B', blog),
      tab('A2', acme)
    ])

    expect(groups.map((g) => g.key)).toEqual(['c:/w/acme', 'c:/w/blog', NO_PROJECT])
    expect(rows(groups[0])).toEqual(['A', 'A2'])
    expect(rows(groups[1])).toEqual(['B'])
    expect(rows(groups[2])).toEqual(['N'])
    expect(groups[2].project).toBeNull()
    expect(groups[0].project).toEqual(acme.project)
  })

  it('a fork stands right after its head, in the head\'s family, and keeps its tab order among forks', () => {
    const family = panelGroups([tab('A', acme), tab('B', acme), tab('A1', acme, 'A')])
    expect(rows(family[0])).toEqual(['A', 'A1 (fork)', 'B'])

    const twoForks = panelGroups([tab('A', acme), tab('B', acme), tab('A1', acme, 'A'), tab('A2', acme, 'A')])
    expect(rows(twoForks[0])).toEqual(['A', 'A1 (fork)', 'A2 (fork)', 'B'])

    const splitForks = panelGroups([tab('A', acme), tab('A1', acme, 'A'), tab('B', acme), tab('A2', acme, 'A')])
    expect(rows(splitForks[0])).toEqual(['A', 'A1 (fork)', 'A2 (fork)', 'B'])

    const forkFirst = panelGroups([tab('A1', acme, 'A'), tab('A', acme)])
    expect(rows(forkFirst[0])).toEqual(['A', 'A1 (fork)'])
  })

  it('a fork whose head is closed or lives in another group is an ordinary row', () => {
    const groups = panelGroups([
      tab('A', acme),
      tab('X', acme, 'gone'),
      tab('Y', blog, 'A')
    ])

    expect(groups.map((g) => g.key)).toEqual(['c:/w/acme', 'c:/w/blog'])
    expect(groups[0].rows).toEqual([
      { id: 'A', fork: false },
      { id: 'X', fork: false }
    ])
    expect(groups[1].rows).toEqual([{ id: 'Y', fork: false }])
  })

  it('panelOrder lists the rows of every group in order', () => {
    const groups = panelGroups([tab('A', acme), tab('N', null), tab('B', blog), tab('A2', acme, 'A')])
    expect(panelOrder(groups)).toEqual(['A', 'A2', 'B', 'N'])
  })
})

describe('moving a tab', () => {
  it('a tab moves down after the target\'s family, carrying its forks', () => {
    const groups = panelGroups([tab('A', acme), tab('B', acme), tab('B1', acme, 'B'), tab('C', acme)])

    expect(moveTab(groups, 'A', 'B')).toEqual(['B', 'B1', 'A', 'C'])
    expect(moveTab(groups, 'B', 'C')).toEqual(['A', 'C', 'B', 'B1'])
  })

  it('a tab moves up before the target\'s family, carrying its forks', () => {
    const groups = panelGroups([tab('A', acme), tab('B', acme), tab('B1', acme, 'B'), tab('C', acme)])

    expect(moveTab(groups, 'C', 'B')).toEqual(['A', 'C', 'B', 'B1'])
  })

  it('a fork moves within its family and lands at the target\'s place among the forks', () => {
    const groups = panelGroups([tab('A', acme), tab('A1', acme, 'A'), tab('A2', acme, 'A'), tab('B', acme)])

    expect(moveTab(groups, 'A2', 'A1')).toEqual(['A', 'A2', 'A1', 'B'])
    expect(moveTab(groups, 'A2', 'A')).toEqual(['A', 'A2', 'A1', 'B'])
    expect(moveTab(groups, 'A1', 'A')).toBeNull()
  })

  it('a fork cannot leave its family', () => {
    const groups = panelGroups([tab('A', acme), tab('A1', acme, 'A'), tab('B', acme), tab('B1', acme, 'B')])

    expect(moveTab(groups, 'A1', 'B')).toBeNull()
    expect(moveTab(groups, 'A1', 'B1')).toBeNull()
  })

  it('a tab cannot move onto a fork, into another group, or onto itself', () => {
    const groups = panelGroups([
      tab('A', acme),
      tab('A1', acme, 'A'),
      tab('B', acme),
      tab('Z', blog),
      tab('N', null)
    ])

    expect(moveTab(groups, 'B', 'A1')).toBeNull()
    expect(moveTab(groups, 'B', 'Z')).toBeNull()
    expect(moveTab(groups, 'B', 'N')).toBeNull()
    expect(moveTab(groups, 'A', 'A')).toBeNull()
    expect(moveTab(groups, 'A', 'missing')).toBeNull()
  })
})

describe('moving a group', () => {
  const groups = panelGroups([tab('A', acme), tab('B', blog), tab('C', cafe), tab('N', null)])

  it('a group moves down after its target', () => {
    expect(moveGroup(groups, 'c:/w/acme', 'c:/w/cafe')).toEqual(['B', 'C', 'A', 'N'])
  })

  it('a group moves up before its target', () => {
    expect(moveGroup(groups, 'c:/w/cafe', 'c:/w/blog')).toEqual(['A', 'C', 'B', 'N'])
  })

  it('the No project group never moves, nothing moves after it, and a group dropped on itself does not change', () => {
    expect(moveGroup(groups, NO_PROJECT, 'c:/w/acme')).toBeNull()
    expect(moveGroup(groups, 'c:/w/acme', NO_PROJECT)).toBeNull()
    expect(moveGroup(groups, 'c:/w/acme', 'c:/w/acme')).toBeNull()
  })
})

describe('group labels', () => {
  it('a project is named by its folder, with its parent when another project has the same name', () => {
    const groups = panelGroups([
      tab('A', place('C:/work/acme', 'work')),
      tab('B', place('C:/home/acme', 'home')),
      tab('Z', blog),
      tab('N', null)
    ])

    const labels = groupLabels(groups)
    expect(labels.get('c:/work/acme')).toBe('acme (work)')
    expect(labels.get('c:/home/acme')).toBe('acme (home)')
    expect(labels.get('c:/w/blog')).toBe('blog')
    expect(labels.get(NO_PROJECT)).toBe('No project')
  })
})

describe('moving a tab on the tab bar, in the order it shows', () => {
  it('a tab dropped on a fork moves before it, and a fork dropped on a tab below it moves after it', () => {
    const groups = storedGroups([tab('A', acme), tab('F', acme, 'A'), tab('B', acme)])
    expect(moveInGroup(groups, 'B', 'F')).toEqual(['A', 'B', 'F'])
    expect(moveInGroup(groups, 'F', 'B')).toEqual(['A', 'B', 'F'])
  })

  it('a tab moves down after its target and up before it; the rest keep their place', () => {
    const groups = storedGroups([tab('X', acme), tab('H', acme), tab('Y', acme), tab('F', acme, 'H')])
    expect(moveInGroup(groups, 'X', 'Y')).toEqual(['H', 'Y', 'X', 'F'])
    expect(moveInGroup(groups, 'Y', 'X')).toEqual(['Y', 'X', 'H', 'F'])
  })

  it('a drop across groups, on itself, or on a tab not shown moves nothing', () => {
    const groups = storedGroups([tab('A', acme), tab('B', blog)])
    expect(moveInGroup(groups, 'A', 'B')).toBeNull()
    expect(moveInGroup(groups, 'A', 'A')).toBeNull()
    expect(moveInGroup(groups, 'A', 'Z')).toBeNull()
  })
})

describe('the tab bar\'s groups keep the tabs\' order', () => {
  it('a group\'s tabs stay in the order they have: a fork put before its head stays there, and the groups keep their order', () => {
    const tabs = [tab('F', acme, 'H'), tab('H', acme), tab('B', blog)]
    expect(panelOrder(panelGroups(tabs))).toEqual(['H', 'F', 'B'])
    expect(panelOrder(storedGroups(tabs))).toEqual(['F', 'H', 'B'])
    expect(storedGroups(tabs).map((g) => g.key)).toEqual(['c:/w/acme', 'c:/w/blog'])
  })
})

describe('showing group labels', () => {
  it('a single group shows no label: one project, or only tabs outside git', () => {
    expect(showsGroupLabels(panelGroups([tab('A1', acme), tab('A2', acme)]))).toBe(false)
    expect(showsGroupLabels(panelGroups([tab('N1', null)]))).toBe(false)
    expect(showsGroupLabels(panelGroups([]))).toBe(false)
  })

  it('two groups show their labels, the No project group included', () => {
    expect(showsGroupLabels(panelGroups([tab('A1', acme), tab('B1', blog)]))).toBe(true)
    expect(showsGroupLabels(panelGroups([tab('A1', acme), tab('N1', null)]))).toBe(true)
  })
})

describe('writing the panel order back', () => {
  it('nothing is written while a place is unknown, whatever the order', () => {
    expect(orderToWrite(['A', 'B'], ['B', 'A'], false)).toBeNull()
  })

  it('once every place is known, the panel order is written when it differs', () => {
    expect(orderToWrite(['A', 'B'], ['B', 'A'], true)).toEqual(['B', 'A'])
  })

  it('an order that is already the panel order is not written', () => {
    expect(orderToWrite(['A', 'B'], ['A', 'B'], true)).toBeNull()
  })
})

describe('coordinator blocks', () => {
  const C: CoordMark = { role: 'coordinator', project: 'acme', sessions: 2, waiting: 0 }
  const to = (coordinatorTabId: string): CoordMark => ({ role: 'attached', project: 'acme', coordinator: 'coord · Desktop', coordinatorTabId })
  const marks = (m: Record<string, CoordMark>) => (id: string): CoordMark | null => m[id] ?? null
  /** a row as `A`, `A1 (fork)`, with its block: `A [C attached]` */
  const shown = (g: PanelGroup): string[] => g.rows.map((r) => `${r.id}${r.fork ? ' (fork)' : ''}${r.block ? ` [${r.block}${r.attached ? ' attached' : ''}]` : ''}`)

  it('the attached tabs of the coordinator\'s group come right after it, in their tab order, and the block is marked', () => {
    const g = arrangeCoordinators(panelGroups([tab('A1', acme), tab('C', acme), tab('X', acme), tab('A2', acme)]), marks({ C, A1: to('C'), A2: to('C') }), true)
    expect(shown(g[0])).toEqual(['C [C]', 'A1 [C attached]', 'A2 [C attached]', 'X'])
  })
  it('a tab attached from another group, or to a coordinator that is not in its group, keeps its place and has no block', () => {
    const g = arrangeCoordinators(panelGroups([tab('C', acme), tab('B', blog), tab('Y', acme)]), marks({ C, B: to('C'), Y: to('Z') }), true)
    expect(shown(g[0])).toEqual(['C [C]', 'Y'])
    expect(shown(g[1])).toEqual(['B'])
  })
  it('with families an attached tab brings its forks, and the coordinator keeps its own', () => {
    const g = arrangeCoordinators(panelGroups([tab('A', acme), tab('C', acme), tab('A1', acme, 'A'), tab('C1', acme, 'C')]), marks({ C, A: to('C') }), true)
    expect(shown(g[0])).toEqual(['C [C]', 'C1 (fork) [C]', 'A [C attached]', 'A1 (fork) [C attached]'])
  })
  it('without families (the tab bar) each tab moves alone, a fork too', () => {
    const g = arrangeCoordinators(storedGroups([tab('F', acme, 'X'), tab('X', acme), tab('C', acme)]), marks({ C, F: to('C') }), false)
    expect(g[0].rows.map((r) => r.id)).toEqual(['X', 'C', 'F'])
  })
  it('arranging the order it gave changes nothing, so the written order stays', () => {
    const m = marks({ C, A2: to('C') })
    const once = panelOrder(arrangeCoordinators(panelGroups(['A2', 'X', 'C'].map((id) => tab(id, acme))), m, true))
    expect(once).toEqual(['X', 'C', 'A2'])
    expect(panelOrder(arrangeCoordinators(panelGroups(once.map((id) => tab(id, acme))), m, true))).toEqual(once)
  })
  it('a group without a coordinator is the same', () => {
    const groups = panelGroups([tab('A', acme), tab('B', acme)])
    expect(arrangeCoordinators(groups, marks({ B: to('Z') }), true)).toEqual(groups)
  })

  describe('drops on a coordinator\'s block', () => {
    const m = marks({ C, A1: to('C'), A2: to('C') })
    const g = arrangeCoordinators(panelGroups(['C', 'A1', 'A2', 'X', 'S'].map((id) => tab(id, acme))), m, true)
    const row = (id: string, o: Partial<DropRow> = {}): DropRow => ({ id, claude: true, local: true, coord: m(id), block: g[0].rows.find((r) => r.id === id)?.block ?? null, ...o })

    it('a Claude tab dropped on the coordinator\'s row attaches it', () => {
      expect(panelDrop(g, row('X'), row('C'))).toEqual({ kind: 'attach', coordinator: 'C', tab: 'X' })
    })
    it('the coordinator\'s own attached tab and a shell tab dropped on it do nothing', () => {
      expect(panelDrop(g, row('A1'), row('C'))).toBeNull()
      expect(panelDrop(g, row('S', { claude: false }), row('C'))).toBeNull()
    })
    it('a Claude tab of another device dropped on the coordinator\'s row attaches it: the hub decides', () => {
      expect(panelDrop(g, row('X', { local: false }), row('C'))).toEqual({ kind: 'attach', coordinator: 'C', tab: 'X' })
    })
    it('an attached row dropped on a row outside the block is detached and put there', () => {
      expect(panelDrop(g, row('A1'), row('X'))).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A1', order: ['C', 'A2', 'X', 'A1', 'S'] })
    })
    it('an attached row dropped on a row of another group is detached and stays in its group', () => {
      expect(panelDrop(g, row('A1'), { id: 'B', claude: true, local: true, coord: null, block: null })).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A1', order: null })
    })
    it('an attached row dropped on another of the block reorders the block', () => {
      expect(panelDrop(g, row('A2'), row('A1'))).toEqual({ kind: 'reorder', order: ['C', 'A2', 'A1', 'X', 'S'] })
    })
    it('an outside row dropped into the block does nothing; outside rows reorder as before', () => {
      expect(panelDrop(g, row('X'), row('A1'))).toBeNull()
      expect(panelDrop(g, row('S'), row('X'))).toEqual({ kind: 'reorder', order: ['C', 'A1', 'A2', 'S', 'X'] })
    })
    it('the coordinator dropped on a row of its own block does nothing', () => {
      expect(panelDrop(g, row('C'), row('A1'))).toBeNull()
    })
    it('dropAttaches refuses the coordinator itself, another coordinator and a target that is no coordinator', () => {
      expect(dropAttaches(row('X'), row('A1'))).toBe(false)
      expect(dropAttaches(row('C'), row('C'))).toBe(false)
      expect(dropAttaches(row('K', { coord: { role: 'coordinator', project: 'beta', sessions: 0, waiting: 0 } }), row('C'))).toBe(false)
      expect(dropAttaches(row('X'), row('C'))).toBe(true)
    })
    it('a tab dropped on the coordinator it is already attached to does nothing; one attached to another coordinator is asked for', () => {
      const attachedTo = (coordinatorTabId: string): CoordMark => ({ role: 'attached', project: 'acme', coordinator: 'coord · Desktop', coordinatorTabId })
      expect(dropAttaches(row('R1', { local: false, coord: attachedTo('C') }), row('C'))).toBe(false)
      expect(dropAttaches(row('R1', { local: false, coord: attachedTo('K') }), row('C'))).toBe(true)
    })
    it('an attached row detached out of a block built by hand leaves the block for the row it is dropped on', () => {
      const hand: PanelGroup[] = [{ key: acme.project.key, project: acme.project, rows: [
        { id: 'C', fork: false, block: 'C' },
        { id: 'A1', fork: false, block: 'C', attached: true },
        { id: 'X', fork: false }
      ] }]
      const drag: DropRow = { id: 'A1', claude: true, local: true, coord: to('C'), block: 'C' }
      const target: DropRow = { id: 'X', claude: true, local: true, coord: null, block: null }
      expect(panelDrop(hand, drag, target)).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A1', order: ['C', 'X', 'A1'] })
    })

    it('an attached row dropped off the rows is detached and goes to the end of its group', () => {
      expect(panelDropOut(g, row('A1'))).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A1', order: ['C', 'A2', 'X', 'S', 'A1'] })
    })
    it('a group that is all one block: an attached row dropped off the rows is detached and goes last, the other groups keep their order', () => {
      const all = arrangeCoordinators(panelGroups([tab('C', acme), tab('A1', acme), tab('A2', acme), tab('B', blog)]), m, true)
      const inBlock = (id: string): DropRow => ({ id, claude: true, local: true, coord: m(id), block: 'C' })
      expect(panelDropOut(all, inBlock('A2'))).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A2', order: ['C', 'A1', 'A2', 'B'] })
      expect(panelDropOut(all, inBlock('A1'))).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A1', order: ['C', 'A2', 'A1', 'B'] })
    })
    it('a row outside a block, and the coordinator, dropped off the rows do nothing', () => {
      expect(panelDropOut(g, row('X'))).toBeNull()
      expect(panelDropOut(g, row('C'))).toBeNull()
    })
    it('a paired device\'s attached row dropped off the rows is detached, with no order: its device keeps its order', () => {
      expect(panelDropOut(g, row('A1', { local: false }))).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A1', order: null })
    })
    it('an attached row dropped off the rows takes its forks to the end of its group; a fork alone stays in its family', () => {
      const fm = marks({ C, A: to('C'), A1: to('C') })
      const fg = arrangeCoordinators(panelGroups([tab('C', acme), tab('A', acme), tab('A1', acme, 'A'), tab('X', acme)]), fm, true)
      const r = (id: string): DropRow => ({ id, claude: true, local: true, coord: fm(id), block: fg[0].rows.find((x) => x.id === id)?.block ?? null })
      expect(panelDropOut(fg, r('A'))).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A', order: ['C', 'X', 'A', 'A1'] })
      expect(panelDropOut(fg, r('A1'))).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A1', order: null })
    })
  })
})

describe('the header\'s Detach', () => {
  it('a tab of this device shows Detach whichever device its coordinator is on; a paired device\'s tab only when its coordinator has an open tab here', () => {
    expect(headerDetachShown(null, 'tab-c')).toBe(true)
    expect(headerDetachShown(null, null)).toBe(true)
    expect(headerDetachShown('dev-laptop', 'tab-c')).toBe(true)
    expect(headerDetachShown('dev-laptop', null)).toBe(false)
  })
})

describe('pulled rows: a paired device\'s session attached to a coordinator of this device', () => {
  const C: CoordMark = { role: 'coordinator', project: 'acme', sessions: 2, waiting: 0 }
  const to = (coordinatorTabId: string | null): CoordMark => ({ role: 'attached', project: 'acme', coordinator: 'coord · Desktop', coordinatorTabId })
  const marks = (m: Record<string, CoordMark>) => (id: string): CoordMark | null => m[id] ?? null
  const shown = (g: PanelGroup): string[] => g.rows.map((r) => `${r.id}${r.fork ? ' (fork)' : ''}${r.block ? ` [${r.block}${r.attached ? ' attached' : ''}]` : ''}`)

  it('pulledBy names the coordinator of an attached tab when that coordinator is a tab of this device, and null otherwise', () => {
    const local = new Set(['C', 'A1'])

    expect(pulledBy(to('C'), local)).toBe('C')
    expect(pulledBy(to('Z'), local)).toBeNull()
    expect(pulledBy(to(null), local)).toBeNull()
    expect(pulledBy(C, local)).toBeNull()
    expect(pulledBy(null, local)).toBeNull()
  })

  it('placePulled puts a remote attached row after the last row of its coordinator\'s block, in the order given, marked attached and pulled', () => {
    const groups = arrangeCoordinators(panelGroups([tab('C', acme), tab('A1', acme), tab('X', acme)]), marks({ C, A1: to('C') }), true)
    const placed = placePulled(groups, [{ id: 'R2', coordinatorTabId: 'C' }, { id: 'R1', coordinatorTabId: 'C' }])

    expect(shown(placed[0])).toEqual(['C [C]', 'A1 [C attached]', 'R2 [C attached]', 'R1 [C attached]', 'X'])
    expect(placed[0].rows.filter((r) => r.pulled).map((r) => r.id)).toEqual(['R2', 'R1'])
    expect(placed[0].rows.filter((r) => !r.pulled).map((r) => r.id)).toEqual(['C', 'A1', 'X'])
  })

  it('a pulled row whose coordinator is not in the groups is not placed', () => {
    const groups = panelGroups([tab('A', acme), tab('X', acme)])

    expect(placePulled(groups, [{ id: 'R1', coordinatorTabId: 'Z' }])).toEqual(groups)
  })

  it('withoutPulled takes the pulled rows out of an order and keeps the rest in place', () => {
    const groups = placePulled(arrangeCoordinators(panelGroups([tab('C', acme), tab('A1', acme)]), marks({ C, A1: to('C') }), true), [{ id: 'R1', coordinatorTabId: 'C' }])

    expect(withoutPulled(['C', 'A1', 'R1', 'X'], groups)).toEqual(['C', 'A1', 'X'])
  })

  it('a group dragged past another group, with a pulled row in it, gives an order with no remote id', () => {
    const groups = placePulled(
      arrangeCoordinators(panelGroups([tab('C', acme), tab('A1', acme), tab('B', blog)]), marks({ C, A1: to('C') }), true),
      [{ id: 'R1', coordinatorTabId: 'C' }]
    )

    expect(moveGroup(groups, acme.project.key, blog.project.key)).toEqual(['B', 'C', 'A1'])
  })

  describe('drops with a pulled row', () => {
    const local = marks({ C, A1: to('C'), A2: to('C') })
    const groups = placePulled(arrangeCoordinators(panelGroups(['C', 'A1', 'A2', 'X'].map((id) => tab(id, acme))), local, true), [{ id: 'R1', coordinatorTabId: 'C' }])
    const blockOf = (id: string): string | null => groups[0].rows.find((r) => r.id === id)?.block ?? null
    const row = (id: string, o: Partial<DropRow> = {}): DropRow => ({ id, claude: true, local: true, coord: local(id), block: blockOf(id), ...o })
    const pulled: DropRow = { id: 'R1', claude: true, local: false, coord: to('C'), block: 'C' }

    it('a pulled row dropped on a row outside its block is detached, with no order: its device keeps its order', () => {
      expect(panelDrop(groups, pulled, row('X'))).toEqual({ kind: 'detach', coordinator: 'C', tab: 'R1', order: null })
    })
    it('a pulled row dropped inside its block does nothing, on the coordinator or on a row of the block', () => {
      expect(panelDrop(groups, pulled, row('A1'))).toBeNull()
      expect(panelDrop(groups, pulled, row('C'))).toBeNull()
    })
    it('a local row dropped on a pulled row inside the block reorders the local rows: the order holds no remote id', () => {
      const target: DropRow = { id: 'R1', claude: true, local: false, coord: to('C'), block: 'C' }

      expect(panelDrop(groups, row('A1'), target)).toEqual({ kind: 'reorder', order: ['C', 'A2', 'A1', 'X'] })
    })
    it('a local attached row detached onto a row outside its block gets an order with no pulled id', () => {
      expect(panelDrop(groups, row('A1'), row('X'))).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A1', order: ['C', 'A2', 'X', 'A1'] })
    })
    it('a pulled row dropped off the rows is detached, with no order', () => {
      expect(panelDropOut(groups, pulled)).toEqual({ kind: 'detach', coordinator: 'C', tab: 'R1', order: null })
    })
    it('a local attached row dropped off the rows goes to the end of its group, in an order with no pulled id', () => {
      expect(panelDropOut(groups, row('A1'))).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A1', order: ['C', 'A2', 'X', 'A1'] })
    })
  })
})

describe("the coordinator chip on a group's header", () => {
  const C: CoordMark = { role: 'coordinator', project: 'acme', sessions: 0, waiting: 0 }
  const to = (coordinatorTabId: string): CoordMark => ({ role: 'attached', project: 'acme', coordinator: 'coord · Desktop', coordinatorTabId })
  const marks = (m: Record<string, CoordMark>) => (id: string): CoordMark | null => m[id] ?? null

  it("a group of this device with a coordinator shows it running, with the coordinator's tab", () => {
    const [g] = panelGroups([tab('A', acme), tab('C', acme)])
    expect(groupChip(g, true, marks({ C }))).toEqual({ kind: 'running', tabId: 'C' })
  })
  it('a group of this device without one offers a start from its first row; an attached row is no coordinator', () => {
    const [g] = panelGroups([tab('A', acme), tab('B', acme)])
    expect(groupChip(g, true, marks({ A: to('Z') }))).toEqual({ kind: 'start', tabId: 'A' })
  })
  it("a pulled row (a paired device's session) is never the tab a start is asked from", () => {
    const g: PanelGroup = { key: acme.project.key, project: acme.project, rows: [{ id: 'R', fork: false, block: 'X', attached: true, pulled: true }, { id: 'A', fork: false }] }
    expect(groupChip(g, true, marks({}))).toEqual({ kind: 'start', tabId: 'A' })
  })
  it("No project and a paired device's groups have no chip, a coordinator there included", () => {
    const [none] = panelGroups([tab('N', null)])
    expect(groupChip(none, true, marks({}))).toBeNull()
    const [remote] = deviceGroups('dev-a', [tab('C', acme)])
    expect(groupChip(remote, false, marks({ C }))).toBeNull()
  })
})
