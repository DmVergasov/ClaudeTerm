import { describe, expect, it } from 'vitest'
import {
  NO_PROJECT,
  groupLabels,
  moveGroup,
  moveTab,
  panelGroups,
  panelOrder,
  type GroupInput,
  type PanelGroup
} from '../../src/renderer/tab-groups'
import type { TabPlace } from '../../src/shared/types'

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
