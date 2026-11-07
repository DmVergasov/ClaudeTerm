import { describe, expect, it } from 'vitest'
import { formatDeviceStatus } from '../../src/main/sync/device-status'
import type { ActiveDevicesView, DeviceView, PairingView } from '../../src/shared/devices'
import type { RemoteTab } from '../../src/shared/remote'

const CODE = 'K7QM-2XPD-9TRA-W4BN'

function view(over: Partial<ActiveDevicesView> = {}): ActiveDevicesView {
  return {
    enabled: true,
    self: { id: 'self-id', name: 'Desk', addresses: ['10.0.0.2'], port: 47821 },
    devices: [{ id: 'laptop-id', name: 'Laptop', platform: 'macos', state: { kind: 'connected' }, addedBy: 'Desk', addedAt: 0, address: null }],
    pairing: null,
    unreachableByOthers: false,
    removedBy: null,
    problem: null,
    keyring: true,
    canLeave: true,
    ...over
  }
}

function pairingWithCode(code: string): PairingView {
  return { code, addresses: ['10.0.0.2:47821'], port: 47821, expiresAt: Date.now() + 300_000 }
}

function device(id: string, name: string, over: Partial<DeviceView> = {}): DeviceView {
  return { id, name, platform: 'linux', state: { kind: 'connected' }, addedBy: 'Desk', addedAt: 0, address: null, ...over }
}

function tab(name: string | null, o: Partial<RemoteTab> = {}): RemoteTab {
  const t: RemoteTab = {
    id: '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11',
    kind: 'claude',
    profile: 'claude',
    cwd: '/src/proj',
    customTitle: name,
    title: null,
    claudeSessionId: null,
    account: null,
    accountName: null,
    muted: false,
    exited: false,
    working: false,
    attention: null,
    attentionSeq: 0,
    images: 0,
    note: false,
    counter: null,
    status: null,
    size: { cols: 80, rows: 24, by: null },
    place: null,
    placeKnown: true,
    folder: '/src/proj',
    forkOf: null,
    fork: false,
    ...o
  }
  if (o.folder === undefined) t.folder = t.cwd
  return t
}

describe('formatDeviceStatus', () => {
  it('names each device, its state and its tabs, and never a code', () => {
    const text = formatDeviceStatus({
      view: view({ pairing: pairingWithCode(CODE) }),
      selfTabs: [tab('build', { working: true })],
      tabsOf: () => [tab('tests', { attention: 'permission' })]
    })
    expect(text).toContain('Laptop (macOS): Connected')
    expect(text).toContain('"build" (Claude, working) in /src/proj')
    expect(text).toContain('"tests" (Claude, waiting: permission) in /src/proj')
    expect(text).toContain('A pairing code is shown.')
    expect(text).not.toContain('K7QM')
  })

  it("a tab's name is its renamed title, else the program's title, else its folder", () => {
    const text = formatDeviceStatus({
      view: view(),
      selfTabs: [
        tab('notes-tab', { title: 'vim' }),
        tab(null, { title: 'vim' }),
        tab(null, { title: null, cwd: '/src/proj' })
      ],
      tabsOf: () => null
    })
    expect(text).toContain('"notes-tab" (Claude) in /src/proj')
    expect(text).toContain('"vim" (Claude) in /src/proj')
    expect(text).toContain('"proj" (Claude) in /src/proj')
  })

  it('a shell tab is named shell, and a tab that waits for the user says why', () => {
    const text = formatDeviceStatus({
      view: view(),
      selfTabs: [tab('sh', { kind: 'shell', cwd: '/home/u/x', folder: '/home/u/x' }), tab('wait', { attention: 'done', working: false })],
      tabsOf: () => null
    })
    expect(text).toContain('"sh" (shell) in /home/u/x')
    expect(text).toContain('"wait" (Claude, waiting: done) in /src/proj')
  })

  it("a tab waiting for another session's turn says so in words; the other waits keep their names", () => {
    const text = formatDeviceStatus({
      view: view(),
      selfTabs: [tab('peer-tab', { attention: 'peer' }), tab('done-tab', { attention: 'done' })],
      tabsOf: () => null
    })
    expect(text).toContain('"peer-tab" (Claude, waiting: another session\'s turn ended) in /src/proj')
    expect(text).toContain('"done-tab" (Claude, waiting: done) in /src/proj')
    expect(text).not.toContain('waiting: peer')
  })

  it('without a group it says how to set one up', () => {
    expect(formatDeviceStatus({ view: null, selfTabs: [], tabsOf: () => null })).toMatch(/^Device sync is not set up/)
  })

  it('says whether this device listens, that the others cannot reach it, and any problem or removal', () => {
    const listening = formatDeviceStatus({ view: view(), selfTabs: [], tabsOf: () => null })
    expect(listening).toContain('Desk (port 47821)')
    const quiet = formatDeviceStatus({ view: view({ self: { id: 'self-id', name: 'Desk', addresses: [], port: null } }), selfTabs: [], tabsOf: () => null })
    expect(quiet).toContain('Desk (not listening)')
    const cut = formatDeviceStatus({ view: view({ unreachableByOthers: true, problem: 'Port 47821 is in use', removedBy: 'Laptop' }), selfTabs: [], tabsOf: () => null })
    expect(cut).toContain('The other devices cannot connect to this one.')
    expect(cut).toContain('Port 47821 is in use')
    expect(cut).toContain('Removed from the group by Laptop')
  })

  it('states an offline device as offline, and a device that has no tabs listed as such', () => {
    const text = formatDeviceStatus({
      view: view({ devices: [device('laptop-id', 'Laptop', { state: { kind: 'offline', since: Date.UTC(2026, 10, 7, 9, 30) } })] }),
      selfTabs: [],
      tabsOf: () => null
    })
    expect(text).toContain('Laptop (Linux): Offline since 2026-11-07T09:30:00.000Z')
    expect(text).not.toContain('"')
  })

  it('words an unreachable device with its address cleaned and cut, and an unknown one as not connected yet', () => {
    const text = formatDeviceStatus({
      view: view({
        devices: [
          device('far-id', 'Far', { state: { kind: 'unreachable', address: '10.0.0.9:47821\u001b' + 'x'.repeat(300) } }),
          device('new-id', 'New', { state: { kind: 'unknown' } })
        ]
      }),
      selfTabs: [],
      tabsOf: () => null
    })
    // the address keeps 254 characters and an ellipsis: 255 in all
    expect(text).toContain(`Far (Linux): Not reachable at 10.0.0.9:47821${'x'.repeat(240)}\u2026`)
    expect(text).toContain('New (Linux): Not connected yet')
  })

  it('a name empty after cleaning is shown as (no name), for this device and for each device', () => {
    const text = formatDeviceStatus({
      view: view({ self: { id: 'self-id', name: '\n', addresses: [], port: 47821 }, devices: [device('laptop-id', '\u001b')] }),
      selfTabs: [],
      tabsOf: () => null
    })
    expect(text).toContain('This device: (no name) (port 47821).')
    expect(text).toContain('(no name) (Linux): Connected')
  })

  it('strips control characters and the line separators from every name, title and folder', () => {
    const text = formatDeviceStatus({
      view: view({ devices: [device('laptop-id', 'Lap\ntop\u001b[31m')] }),
      selfTabs: [tab('a\nb\u001b[31mc', { folder: '/x\u2028y\u0085z' })],
      tabsOf: () => null
    })
    expect(text).toContain('"ab[31mc" (Claude) in /xyz')
    expect(text).toContain('Laptop[31m (Linux): Connected') // the device line keeps its name without the controls
    // the text's own line breaks stay; every other control character and the separators are gone
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/)
  })

  it('a title cannot close its own quotes, and bidi and zero-width characters are removed', () => {
    const text = formatDeviceStatus({
      view: view(),
      selfTabs: [tab('x" ) in /etc\u202e\u200b\u2066'), tab('ok', { folder: '/a\u202eb\u200cc' })],
      tabsOf: () => null
    })
    // one quoted name on its own line: the double quote became a single one
    expect(text.split('\n').filter((line) => line.includes('/etc'))).toEqual(['  "x\' ) in /etc" (Claude) in /src/proj'])
    expect(text).toContain('"ok" (Claude) in /abc')
  })

  it('the heading of a device\'s tabs carries its platform, so two devices with one name get different headings', () => {
    const text = formatDeviceStatus({
      view: view({ devices: [device('a-id', 'Laptop', { platform: 'macos' }), device('b-id', 'Laptop', { platform: 'windows' })] }),
      selfTabs: [],
      tabsOf: () => []
    })
    expect(text).toContain('Tabs of Laptop (macOS):')
    expect(text).toContain('Tabs of Laptop (Windows):')
  })

  it('removes the Arabic letter mark, the word joiner and the invisible operators from every name, title and folder', () => {
    const text = formatDeviceStatus({
      view: view({ devices: [device('laptop-id', 'La\u061Cp\u2060t\u2061o\u2062p\u2063\u2064')] }),
      selfTabs: [tab('x\u061C\u2060y', { folder: '/a\u2061b' })],
      tabsOf: () => null
    })
    expect(text).toContain('Laptop (Linux): Connected')
    expect(text).toContain('"xy" (Claude) in /ab')
    expect(text).not.toMatch(/[\u061C\u2060-\u2064]/)
  })

  it('a view of 100 devices with long tabs stops once the budget is spent: the last device\'s tabs are never formatted', () => {
    const devices = Array.from({ length: 100 }, (_, i) => device(`d${i}`, `Dev${i}`))
    let folderReads = 0
    // a tab's folder is read once per format of the tab: the reads count the formats
    const counted = (t: RemoteTab): RemoteTab =>
      Object.defineProperty({ ...t }, 'folder', {
        get: () => {
          folderReads++
          return '/src/proj'
        },
        enumerable: true
      }) as RemoteTab
    const asked: string[] = []
    // 50 tabs of about 100 characters each: a few devices' tabs fill the budget, and the rest are not reached
    const tabsOf = (id: string): RemoteTab[] => {
      asked.push(id)
      return Array.from({ length: 50 }, (_, i) => counted(tab(`${id} tab ${i} ${'t'.repeat(60)}`)))
    }
    const text = formatDeviceStatus({ view: view({ devices }), selfTabs: [], tabsOf })
    expect(text.length).toBeLessThanOrEqual(16_000)
    expect(text.endsWith('\u2026 (cut)')).toBe(true)
    expect(text).toContain('Tabs of Dev0 (Linux):')
    expect(asked[0]).toBe('d0')
    expect(asked).not.toContain('d99')
    expect(asked.length).toBeLessThan(devices.length)
    expect(folderReads).toBeLessThan(devices.length * 50)
  })

  it('cuts a name or title to 100 characters and a folder to 300, with an ellipsis', () => {
    const text = formatDeviceStatus({
      view: view(),
      selfTabs: [tab('x'.repeat(150), { folder: '/' + 'y'.repeat(399) })],
      tabsOf: () => null
    })
    expect(text).toContain(`"${'x'.repeat(99)}\u2026" (Claude) in ${('/' + 'y'.repeat(399)).slice(0, 299)}\u2026`)
  })

  it('never splits a surrogate pair when it cuts', () => {
    const text = formatDeviceStatus({
      view: view(),
      selfTabs: [tab('a'.repeat(98) + '😀bb')],
      tabsOf: () => null
    })
    expect(text).toContain(`"${'a'.repeat(98)}\u2026"`)
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('lists at most 50 tabs per device, then says how many more there are', () => {
    const tabs = Array.from({ length: 60 }, (_, i) => tab(`t${i}`))
    const text = formatDeviceStatus({ view: view(), selfTabs: tabs, tabsOf: () => null })
    expect(text).toContain('"t49"')
    expect(text).not.toContain('"t50"')
    expect(text).toContain('\u2026 and 10 more tabs')
    expect(text.split('\n').filter((line) => line.includes(' in /src/proj')).length).toBe(50)
  })

  it('when the text is cut, every device line is still there, before any tab, and the text ends with the cut mark', () => {
    const devices = Array.from({ length: 20 }, (_, i) => device(`d${i}`, `Dev${i}`))
    const long = (i: number) => tab(`tab-${i}-${'z'.repeat(90)}`, { folder: '/' + 'f'.repeat(299) })
    const text = formatDeviceStatus({
      view: view({ devices }),
      selfTabs: Array.from({ length: 60 }, (_, i) => long(i)),
      tabsOf: () => Array.from({ length: 60 }, (_, i) => long(i))
    })
    expect(text.length).toBeLessThan(16_000)
    expect(text.endsWith('\u2026 (cut)')).toBe(true)
    for (let i = 0; i < 20; i++) expect(text).toContain(`Dev${i} (Linux): Connected`)
    expect(text.indexOf('Dev19 (Linux): Connected')).toBeLessThan(text.indexOf('Tabs of this device:'))
  })

  it('lists a device whose tabs cannot be read, and the rest of the answer', () => {
    const text = formatDeviceStatus({
      view: view({ devices: [device('laptop-id', 'Laptop'), device('pad-id', 'Pad')] }),
      selfTabs: [tab('ok'), { ...tab('bad'), folder: null as unknown as string }],
      tabsOf: (id) => {
        if (id === 'laptop-id') throw new Error('broken')
        return [tab('pad-tab')]
      }
    })
    expect(text).toContain('"ok" (Claude) in /src/proj')
    expect(text).not.toContain('"bad"')
    expect(text).toContain('Laptop (Linux): Connected')
    expect(text).toContain('Tabs of Laptop (Linux):\n  tabs could not be read')
    expect(text).toContain('Pad (Linux): Connected')
    expect(text).toContain('"pad-tab" (Claude) in /src/proj')
  })

  it('never shows a pairing code, an address of the pairing, or a key or fingerprint of a device: their values are not in the text', () => {
    const FINGERPRINT = 'AB:CD:EF:01:23:45:67:89'
    const PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx7Qs'
    const paired = {
      ...device('laptop-id', 'Laptop'),
      fingerprint: FINGERPRINT,
      publicKey: `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY}\n-----END PUBLIC KEY-----`
    } as unknown as DeviceView
    const text = formatDeviceStatus({
      view: view({ pairing: pairingWithCode(CODE), devices: [paired] }),
      selfTabs: [tab('build')],
      tabsOf: () => [tab('tests')]
    })
    expect(text).toContain('A pairing code is shown.')
    expect(text).toContain('"tests"')
    for (const secret of [CODE, FINGERPRINT, PUBLIC_KEY, 'BEGIN PUBLIC KEY', '10.0.0.2:47821']) {
      expect(text).not.toContain(secret)
    }
  })
})
