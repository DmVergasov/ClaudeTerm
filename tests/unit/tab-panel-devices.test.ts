import { describe, expect, it } from 'vitest'
import {
  NO_PROJECT,
  deviceGroupKey,
  deviceGroups,
  groupLabels,
  moveGroup,
  moveTab,
  tabBarOrder,
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

/** The rows of one group as readable strings: `A` or `A1 (fork)`. */
function rows(group: PanelGroup): string[] {
  return group.rows.map((r) => (r.fork ? `${r.id} (fork)` : r.id))
}

describe('device sections: the fold keys', () => {
  it('a project group of another device folds under its device and its project key', () => {
    expect(deviceGroupKey('dev-a', 'c:/w/acme')).toBe('dev-a\nc:/w/acme')
  })

  it('two devices with a project of the same key have groups that stay apart', () => {
    const studio = deviceGroups('dev-a', [tab('A', acme)])
    const laptop = deviceGroups('dev-b', [tab('B', acme)])

    expect(studio[0].key).not.toBe(laptop[0].key)
    expect(studio[0].key).toBe(deviceGroupKey('dev-a', acme.project.key))
    expect(rows(studio[0])).toEqual(['A'])
    expect(rows(laptop[0])).toEqual(['B'])
  })

  it('a device section keeps the groups of its own tabs: projects in order, tabs outside git last', () => {
    const groups = deviceGroups('dev-a', [tab('N', null), tab('B', blog), tab('A', acme), tab('A2', acme)])

    expect(groups.map((g) => g.key)).toEqual([deviceGroupKey('dev-a', blog.project.key), deviceGroupKey('dev-a', acme.project.key), deviceGroupKey('dev-a', NO_PROJECT)])
    expect(rows(groups[1])).toEqual(['A', 'A2'])
    expect(groups[2].project).toBeNull()
  })

  it('a fork of another device\'s tab is an ordinary row in this device\'s section', () => {
    const groups = deviceGroups('dev-a', [tab('A', acme), tab('X1', acme, 'Z-on-another-device')])

    expect(rows(groups[0])).toEqual(['A', 'X1'])
  })

  it('a section\'s no-project group is never moved, by a drag of its groups', () => {
    const groups = deviceGroups('dev-a', [tab('A', acme), tab('N', null)])
    const none = deviceGroupKey('dev-a', NO_PROJECT)

    expect(moveGroup(groups, deviceGroupKey('dev-a', acme.project.key), none)).toBeNull()
    expect(moveGroup(groups, none, deviceGroupKey('dev-a', acme.project.key))).toBeNull()
  })

  it('a drag of a tab never crosses into another device\'s section', () => {
    const studio = deviceGroups('dev-a', [tab('A', acme), tab('A2', acme)])
    const laptop = deviceGroups('dev-b', [tab('B', acme), tab('B2', acme)])

    expect(moveTab(studio, 'B', 'A')).toBeNull()
    expect(moveTab(laptop, 'A', 'B2')).toBeNull()
    expect(moveTab(studio, 'A2', 'A')).toEqual(['A2', 'A'])
  })

  it('the labels of a section name its projects, as on this device', () => {
    const labels = groupLabels(deviceGroups('dev-a', [tab('A', place('C:/work/acme', 'work')), tab('B', place('C:/home/acme', 'home')), tab('N', null)]))

    expect([...labels.values()]).toEqual(['acme (work)', 'acme (home)', 'No project'])
  })
})

describe('the tab order on the tab bar: a remote fork stands after its family', () => {
  const ids = (tabs: { id: string; forkOf: string | null }[], dragged: string[] = []) => tabBarOrder(tabs, dragged)

  it('a fork that arrives after other tabs stands right after its head', () => {
    expect(ids([{ id: 'A', forkOf: null }, { id: 'B', forkOf: null }, { id: 'A1', forkOf: 'A' }])).toEqual(['A', 'A1', 'B'])
  })

  it('a second fork follows the first one, in arrival order', () => {
    expect(ids([{ id: 'A', forkOf: null }, { id: 'B', forkOf: null }, { id: 'A1', forkOf: 'A' }, { id: 'A2', forkOf: 'A' }])).toEqual(['A', 'A1', 'A2', 'B'])
  })

  it('a fork whose head is not in the list stays where it arrived', () => {
    expect(ids([{ id: 'X', forkOf: null }, { id: 'A1', forkOf: 'Z' }, { id: 'Y', forkOf: null }])).toEqual(['X', 'A1', 'Y'])
  })

  it('a fork of a fork joins the family, and nothing is lost', () => {
    expect(ids([{ id: 'A', forkOf: null }, { id: 'B', forkOf: null }, { id: 'A2', forkOf: 'A1' }, { id: 'A1', forkOf: 'A' }])).toEqual(['A', 'A1', 'A2', 'B'])
  })

  it('a group this window dragged keeps the drag order; a tab that came since and is no fork follows it', () => {
    expect(ids([{ id: 'A', forkOf: null }, { id: 'B', forkOf: null }, { id: 'C', forkOf: null }], ['B', 'A'])).toEqual(['B', 'A', 'C'])
  })

  it('a fork that arrives after a drag stands right after its family, also when its group was dragged', () => {
    expect(ids([{ id: 'A', forkOf: null }, { id: 'B', forkOf: null }, { id: 'A1', forkOf: 'A' }], ['A', 'B'])).toEqual(['A', 'A1', 'B'])
    expect(ids([{ id: 'A', forkOf: null }, { id: 'B', forkOf: null }, { id: 'A1', forkOf: 'A' }], ['B', 'A'])).toEqual(['B', 'A', 'A1'])
  })

  it('a fork the user dragged keeps the place the drag gave it', () => {
    expect(ids([{ id: 'A', forkOf: null }, { id: 'B', forkOf: null }, { id: 'A1', forkOf: 'A' }], ['A', 'B', 'A1'])).toEqual(['A', 'B', 'A1'])
  })

  it('a fork of a fork that arrives after a drag goes after the whole family', () => {
    expect(ids([{ id: 'A', forkOf: null }, { id: 'B', forkOf: null }, { id: 'A2', forkOf: 'A1' }, { id: 'A1', forkOf: 'A' }], ['B', 'A'])).toEqual(['B', 'A', 'A1', 'A2'])
  })

  it('a dragged id that is gone is dropped from the order', () => {
    expect(ids([{ id: 'A', forkOf: null }], ['Gone', 'A'])).toEqual(['A'])
  })
})
