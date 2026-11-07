import { isIPv6 } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { MAX_ADDRESS_LENGTH } from '../../shared/devices'

/** The most addresses a device announces about itself. */
const MAX_LOCAL_ADDRESSES = 16
const HOST_RE = /^[A-Za-z0-9._:-]+$/
const PORT_RE = /^\d{1,5}$/

/**
 * An address as people type it: a host name or IP address, optionally with :port, IPv6 in brackets when a port follows.
 * Null when the text is not an address. The port is `defaultPort` when none is typed.
 */
export function parseAddress(input: string, defaultPort: number): { host: string; port: number } | null {
  const text = input.trim()
  if (text.length === 0 || text.length > MAX_ADDRESS_LENGTH) return null
  let host: string
  let portText: string | null = null
  if (text.startsWith('[')) {
    const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(text)
    if (!bracketed || !isIPv6(bracketed[1])) return null
    host = bracketed[1]
    portText = bracketed[2] ?? null
  } else if ((text.match(/:/g) ?? []).length > 1) {
    // a bare IPv6 address: its colons are not a port
    if (!isIPv6(text)) return null
    host = text
  } else {
    const colon = text.indexOf(':')
    if (colon < 0) {
      host = text
    } else {
      host = text.slice(0, colon)
      portText = text.slice(colon + 1)
    }
  }
  if (!HOST_RE.test(host)) return null
  let port = defaultPort
  if (portText !== null) {
    if (!PORT_RE.test(portText)) return null
    port = Number(portText)
    if (port < 1 || port > 65535) return null
  }
  return { host, port }
}

/**
 * The addresses other devices can reach this one at: the external IPv4 addresses first, then the external IPv6 ones
 * (link-local ones need an interface name, so they are left out). At most 16.
 */
export function localAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const v4: string[] = []
  const v6: string[] = []
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.internal) continue
      const family: unknown = info.family
      if (family === 'IPv4' || family === 4) v4.push(info.address)
      else if (!info.address.toLowerCase().startsWith('fe80:')) v6.push(info.address)
    }
  }
  return [...new Set([...v4, ...v6])].slice(0, MAX_LOCAL_ADDRESSES)
}
