import { describe, expect, it } from 'vitest'
import { attachTabsOf, type AttachableTab, canAttachTo } from '../../src/renderer/attach-tabs'

/** a Claude tab of this device, in a folder with a branch, with a session; the cases change one field */
const tab = (over: Partial<AttachableTab> = {}): AttachableTab => ({
  id: 'tab-1', title: 'parser', kind: 'claude', claudeSessionId: 'a1000000-0000-4000-8000-000000000002', exited: false, folder: '/work/acme', branch: 'main', device: null, ...over
})

describe('canAttachTo', () => {
  it('a Claude tab dropped on another coordinator\'s panel attaches; the coordinator itself and a shell tab do not', () => {
    expect(canAttachTo('C', 'X', { kind: 'claude' })).toBe(true)
    expect(canAttachTo('C', 'C', { kind: 'claude' })).toBe(false)
    expect(canAttachTo('C', 'S', { kind: 'shell' })).toBe(false)
    expect(canAttachTo('C', 'gone', undefined)).toBe(false)
  })
})

describe('attachTabsOf', () => {
  it('a Claude tab of this device is offered with its session, folder and branch, and no device name', () => {
    expect(attachTabsOf([tab()])).toEqual([
      { id: 'tab-1', title: 'parser', claude: true, device: null, session: 'a1000000-0000-4000-8000-000000000002', exited: false, folder: '/work/acme', branch: 'main' }
    ])
  })

  it('a tab of a paired device is offered under that device\'s name while the device is online', () => {
    expect(attachTabsOf([tab({ id: 'tab-l1', device: { name: 'Laptop', online: true } })])).toEqual([
      expect.objectContaining({ id: 'tab-l1', device: 'Laptop', claude: true })
    ])
  })

  it('a tab of a paired device that is offline is left out: it takes no input, and nothing can attach there', () => {
    expect(attachTabsOf([tab({ id: 'tab-l1', device: { name: 'Laptop', online: false } }), tab({ id: 'tab-1' })]).map((t) => t.id)).toEqual(['tab-1'])
  })

  it('a shell tab is offered as not a Claude tab', () => {
    expect(attachTabsOf([tab({ kind: 'shell', claudeSessionId: null })])).toEqual([expect.objectContaining({ claude: false, session: null })])
  })
})
