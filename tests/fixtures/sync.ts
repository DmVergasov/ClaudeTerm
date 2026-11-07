import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tls from 'node:tls'
import type { Vault } from '../../src/main/accounts'
import { createIdentity, type DeviceIdentity } from '../../src/main/sync/identity'
import { PeerLink, type PeerLinkOptions } from '../../src/main/sync/peer-link'

/** "encrypts" by prefixing, so a test sees what was stored; decrypt throws for anything without the prefix */
export function fakeVault(available = true): Vault {
  return {
    available: () => available,
    encrypt: (text) => `enc:${text}`,
    decrypt: (data) => {
      if (!data.startsWith('enc:')) throw new Error('cannot decrypt')
      return data.slice(4)
    }
  }
}

/** polls every 20 ms until the condition holds; throws when it does not hold within `ms` */
export async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('until: timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** a new folder in the temp folder, for one test's data files */
export function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `ct-${tag}-`))
}

/** key generation is slow enough to share: the identities are made once and handed out in order */
const made: Promise<DeviceIdentity>[] = []

/** n identities, the same ones on every call */
export async function identities(n: number): Promise<DeviceIdentity[]> {
  while (made.length < n) made.push(createIdentity())
  return Promise.all(made.slice(0, n))
}

/** one identity shared by the tests that only need some identity */
export async function testIdentity(): Promise<DeviceIdentity> {
  return (await identities(1))[0]
}

/** the servers, sockets and links that the link pairs of a test opened: closeLinkPairs closes them */
export const openServers: tls.Server[] = []
export const openSockets: tls.TLSSocket[] = []
export const openLinks: PeerLink[] = []

/** closes what the link pairs of the test opened; call it in afterEach */
export async function closeLinkPairs(): Promise<void> {
  for (const l of openLinks.splice(0)) l.close('test over')
  for (const s of openSockets.splice(0)) s.destroy()
  await Promise.all(openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
}

/** A loopback TLS pair: `client` is the outbound side, `server` the inbound one; both are wrapped in a PeerLink. */
export async function linkPair(
  opts: Partial<PeerLinkOptions> = {},
  serverOpts: Partial<PeerLinkOptions> = opts
): Promise<{ client: PeerLink; server: PeerLink; clientSocket: tls.TLSSocket; serverSocket: tls.TLSSocket }> {
  const id = await testIdentity()
  const tlsServer = tls.createServer({
    key: id.keyPem,
    cert: id.certPem,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3'
  })
  openServers.push(tlsServer)
  tlsServer.listen(0, '127.0.0.1')
  await once(tlsServer, 'listening')
  const port = (tlsServer.address() as { port: number }).port

  const serverSide = once(tlsServer, 'secureConnection') as Promise<[tls.TLSSocket]>
  const clientSocket = tls.connect({
    host: '127.0.0.1',
    port,
    key: id.keyPem,
    cert: id.certPem,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3'
  })
  openSockets.push(clientSocket)
  await once(clientSocket, 'secureConnect')
  const [serverSocket] = await serverSide
  openSockets.push(serverSocket)

  const client = new PeerLink(clientSocket, { outbound: true, ...opts })
  const server = new PeerLink(serverSocket, { outbound: false, ...serverOpts })
  openLinks.push(client, server)
  return { client, server, clientSocket, serverSocket }
}
