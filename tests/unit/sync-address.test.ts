import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { localAddresses, parseAddress } from '../../src/main/sync/address'

describe('parseAddress', () => {
  it('parses addresses as people type them', () => {
    expect(parseAddress('macbook', 47821)).toEqual({ host: 'macbook', port: 47821 })
    expect(parseAddress(' 192.168.1.20:5000 ', 47821)).toEqual({ host: '192.168.1.20', port: 5000 })
    expect(parseAddress('[::1]:47821', 1)).toEqual({ host: '::1', port: 47821 })
    expect(parseAddress('[::1]', 47821)).toEqual({ host: '::1', port: 47821 })
    expect(parseAddress('::1', 47821)).toEqual({ host: '::1', port: 47821 })
  })

  it('accepts IPv6 addresses with and without a port', () => {
    for (const good of ['::1', '[::1]:47821', 'fe80::1', '2001:db8::5']) expect(parseAddress(good, 47821)).not.toBeNull()
  })

  it('refuses text with colons that is not IPv6', () => {
    for (const bad of ['macbook:5000:', '1.2.3.4:5:6', '[abc:def]']) expect(parseAddress(bad, 47821)).toBeNull()
  })

  it('refuses an address longer than the limit', () => {
    expect(parseAddress('a'.repeat(256), 47821)).toBeNull()
    expect(parseAddress('a'.repeat(255), 47821)).not.toBeNull()
  })

  it('refuses what is not an address', () => {
    for (const bad of ['', '   ', 'host:0', 'host:99999', 'host:abc', 'host:', '[::1', '[::1]x', '[host]:5', 'a b']) {
      expect(parseAddress(bad, 47821)).toBeNull()
    }
  })
})

describe('localAddresses', () => {
  it('keeps the external ones, IPv4 first', () => {
    const ifaces = {
      lo: [
        { address: '127.0.0.1', family: 'IPv4', internal: true },
        { address: '::1', family: 'IPv6', internal: true }
      ],
      eth0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '100.64.0.5', family: 'IPv4', internal: false },
        { address: '2001:db8::5', family: 'IPv6', internal: false }
      ]
    } as unknown as NodeJS.Dict<NetworkInterfaceInfo[]>
    expect(localAddresses(ifaces)).toEqual(['100.64.0.5', '2001:db8::5'])
  })

  it('lists each address once, and at most sixteen', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ address: `100.64.0.${i + 1}`, family: 'IPv4', internal: false }))
    const dup = { address: '100.64.0.1', family: 'IPv4', internal: false }
    const cast = (v: unknown) => v as NodeJS.Dict<NetworkInterfaceInfo[]>
    expect(localAddresses(cast({ eth0: [...many, dup] }))).toHaveLength(16)
    expect(localAddresses(cast({ eth0: [dup], wlan0: [dup] }))).toEqual(['100.64.0.1'])
  })
})
