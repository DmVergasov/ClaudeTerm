import { describe, expect, it } from 'vitest'
import { coordMenuEntries, type CoordMenuInput } from '../../src/renderer/coord-menu'
import type { CoordMark } from '../../src/shared/coordinator'

const acmeCoordinator: CoordMark = { role: 'coordinator', project: 'acme', sessions: 0, waiting: 0 }
const attachedTo = (coordinatorTabId: string | null): CoordMark => ({ role: 'attached', project: 'acme', coordinator: 'coord · Desktop', coordinatorTabId })

/** a local Claude tab with a session and a project, unattached, with no coordinator to offer; the cases change one field */
const local = (o: Partial<CoordMenuInput> = {}): CoordMenuInput => ({ remote: false, hasSession: true, hasProject: true, project: 'acme', mark: null, coordinators: [], ...o })

describe('the tab menu\'s coordinator items', () => {
  it('an attached tab, local or remote, with its coordinator or without one, gets only Detach from the coordinator\'s project', () => {
    const detach = [{ label: 'Detach from the acme coordinator', disabled: false, action: { kind: 'detach' } }]

    expect(coordMenuEntries(local({ mark: attachedTo('C') }))).toEqual(detach)
    expect(coordMenuEntries(local({ remote: true, hasProject: false, project: null, mark: attachedTo('C') }))).toEqual(detach)
    expect(coordMenuEntries(local({ remote: true, hasProject: false, project: null, mark: attachedTo(null) }))).toEqual(detach)
  })

  it('a local coordinator gets only Stop coordinating, and a remote coordinator gets nothing', () => {
    expect(coordMenuEntries(local({ mark: acmeCoordinator }))).toEqual([{ label: 'Stop coordinating', disabled: false, action: { kind: 'stop' } }])
    expect(coordMenuEntries(local({ remote: true, hasProject: false, project: null, mark: acmeCoordinator }))).toEqual([])
  })

  it('a local unattached tab with a project gets Attach to each coordinator, its own project\'s first, then Make project coordinator', () => {
    const entries = coordMenuEntries(local({
      project: 'acme',
      coordinators: [{ tabId: 'K', project: 'blog' }, { tabId: 'A', project: 'Acme' }]
    }))

    expect(entries).toEqual([
      { label: 'Attach to the Acme coordinator', disabled: false, action: { kind: 'attach', coordinatorTabId: 'A' } },
      { label: 'Attach to the blog coordinator', disabled: false, action: { kind: 'attach', coordinatorTabId: 'K' } },
      { label: 'Make project coordinator', disabled: false, action: { kind: 'make' } }
    ])
  })

  it('a remote unattached tab gets the Attach items only, with no Make project coordinator', () => {
    const entries = coordMenuEntries(local({ remote: true, hasProject: false, project: null, coordinators: [{ tabId: 'K', project: 'blog' }] }))

    expect(entries).toEqual([{ label: 'Attach to the blog coordinator', disabled: false, action: { kind: 'attach', coordinatorTabId: 'K' } }])
  })

  it('a tab without a session gets the same items, all disabled', () => {
    const entries = coordMenuEntries(local({ hasSession: false, coordinators: [{ tabId: 'K', project: 'blog' }] }))

    expect(entries).toEqual([
      { label: 'Attach to the blog coordinator', disabled: true, action: { kind: 'attach', coordinatorTabId: 'K' } },
      { label: 'Make project coordinator', disabled: true, action: { kind: 'make' } }
    ])
  })

  it('with no coordinator, a local tab with a project gets Make only, and a local tab without a project gets nothing', () => {
    expect(coordMenuEntries(local())).toEqual([{ label: 'Make project coordinator', disabled: false, action: { kind: 'make' } }])
    expect(coordMenuEntries(local({ hasProject: false, project: null }))).toEqual([])
  })
})
