import { describe, expect, it } from 'vitest'
import {
  NO_PROJECT,
  deviceGroupKey,
  deviceGroups,
  groupLabels,
  moveGroup,
  moveTab,
  panelDeviceOrder,
  panelOrder,
  panelOwnOrder,
  panelSections,
  tabBarOrder,
  type GroupInput,
  type PanelGroup,
  type PanelItem
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

  // the panel's sections are a pure function of its items: a paired device's session attached to a coordinator here is
  // pulled into that coordinator's block and leaves its device's section (the DOM is not in node's test environment)
  describe('a pulled row: a paired device\'s session attached to a coordinator of this device', () => {
    const C: CoordMark = { role: 'coordinator', project: 'acme', sessions: 1, waiting: 0 }
    const to = (coordinatorTabId: string | null): CoordMark => ({ role: 'attached', project: 'acme', coordinator: 'coord · Studio', coordinatorTabId })
    const item = (id: string, o: Partial<PanelItem> = {}): PanelItem => ({ id, place: acme, forkOf: null, group: null, coord: null, ...o })
    const devices = [{ id: 'dev-b', online: true }]
    /** the rows of the groups as `id [block attached]`, pulled rows marked */
    const shown = (groups: PanelGroup[]): string[] => groups.flatMap((g) => g.rows.map((r) => `${r.id}${r.block ? ` [${r.block}${r.attached ? ' attached' : ''}]` : ''}`))
    const items = (r1: CoordMark | null): PanelItem[] => [
      item('C', { coord: C }),
      item('A1', { coord: to('C') }),
      item('R1', { group: 'dev-b', coord: r1 }),
      item('R2', { group: 'dev-b' })
    ]

    it('the remote row is in its coordinator\'s block, after the local attached row, marked attached and pulled', () => {
      const [own] = panelSections(items(to('C')), devices)

      expect(own.device).toBeNull()
      expect(shown(own.groups)).toEqual(['C [C]', 'A1 [C attached]', 'R1 [C attached]'])
      expect(own.groups[0].rows.find((r) => r.id === 'R1')?.pulled).toBe(true)
    })

    it('its device\'s section has no row with its id, and the section\'s count leaves it out', () => {
      const [, laptop] = panelSections(items(to('C')), devices)

      expect(laptop.device?.id).toBe('dev-b')
      expect(shown(laptop.groups)).toEqual(['R2'])
      expect(laptop.groups[0].rows.length).toBe(1)
    })

    it('the panel\'s visual order has no remote id', () => {
      const [own] = panelSections(items(to('C')), devices)

      expect(panelOwnOrder(own.groups)).toEqual(['C', 'A1'])
      expect(panelOrder(own.groups)).toContain('R1')
    })

    it('the keyboard walks a device\'s section ids, then its pulled rows at the end', () => {
      const parts = panelSections(items(to('C')), devices)

      expect(panelDeviceOrder(devices, parts, [{ id: 'R1', device: 'dev-b' }], new Set())).toEqual(['R2', 'R1'])
    })

    it('a folded device\'s section ids are left out, but its pulled row is still reached', () => {
      const parts = panelSections(items(to('C')), devices)

      expect(panelDeviceOrder(devices, parts, [{ id: 'R1', device: 'dev-b' }], new Set(['dev-b']))).toEqual(['R1'])
    })

    it('a device with only pulled tabs that is offline has no section, and its pulled row is still reached', () => {
      const offline = [{ id: 'dev-b', online: false }]
      const parts = panelSections([item('C', { coord: C }), item('A1', { coord: to('C') }), item('R1', { group: 'dev-b', coord: to('C') })], offline)

      expect(parts.map((p) => p.device?.id ?? null)).toEqual([null])
      expect(panelDeviceOrder(offline, parts, [{ id: 'R1', device: 'dev-b' }], new Set())).toEqual(['R1'])
    })

    it('with the mark gone, the row is back in its device\'s section', () => {
      const [own, laptop] = panelSections(items(null), devices)

      expect(shown(own.groups)).toEqual(['C [C]', 'A1 [C attached]'])
      expect(shown(laptop.groups)).toEqual(['R1', 'R2'])
    })

    it('a remote tab attached to a coordinator that is not a tab of this device is not pulled and stays in its section', () => {
      const [own, laptop] = panelSections([...items(null), item('R3', { group: 'dev-b', coord: to('Z') })], devices)

      expect(shown(own.groups)).toEqual(['C [C]', 'A1 [C attached]'])
      expect(shown(laptop.groups)).toEqual(['R1', 'R2', 'R3'])
    })
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
