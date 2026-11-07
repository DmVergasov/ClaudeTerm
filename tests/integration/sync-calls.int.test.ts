import { once } from 'node:events'
import * as tls from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { Calls, type CallEntry } from '../../src/main/sync/calls'
import { PeerLink } from '../../src/main/sync/peer-link'
import { MAX_FRAME_BYTES } from '../../src/main/sync/wire'
import { testIdentity } from '../fixtures/sync'

const servers: tls.Server[] = []
const sockets: tls.TLSSocket[] = []
const links: PeerLink[] = []

afterEach(async () => {
  for (const l of links.splice(0)) l.close('test over')
  for (const s of sockets.splice(0)) s.destroy()
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

/** A loopback TLS pair: `client` is the outbound side, `server` the inbound one; both are wrapped in a PeerLink. */
async function linkPair(): Promise<{ client: PeerLink; server: PeerLink }> {
  const id = await testIdentity()
  const tlsServer = tls.createServer({ key: id.keyPem, cert: id.certPem, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
  servers.push(tlsServer)
  tlsServer.listen(0, '127.0.0.1')
  await once(tlsServer, 'listening')
  const port = (tlsServer.address() as { port: number }).port

  const serverSide = once(tlsServer, 'secureConnection') as Promise<[tls.TLSSocket]>
  const clientSocket = tls.connect({ host: '127.0.0.1', port, key: id.keyPem, cert: id.certPem, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
  sockets.push(clientSocket)
  await once(clientSocket, 'secureConnect')
  const [serverSocket] = await serverSide
  sockets.push(serverSocket)

  const client = new PeerLink(clientSocket, { outbound: true })
  const server = new PeerLink(serverSocket, { outbound: false })
  links.push(client, server)
  return { client, server }
}

describe('calls over a real link', () => {
  // I1: a reply that cannot be sent is refused; the link stays up and the next call is served
  it('a reply over MAX_FRAME_BYTES is refused as failed, and the link stays open', async () => {
    const { client, server } = await linkPair()
    const huge: CallEntry = { run: () => 'x'.repeat(MAX_FRAME_BYTES) }
    const echo: CallEntry = { run: (args) => args }
    const caller = new Calls(client, {})
    new Calls(server, { huge, echo })
    const closed: string[] = []
    client.on('close', (r: string) => closed.push(r))
    server.on('close', (r: string) => closed.push(r))

    await expect(caller.call('huge', {})).rejects.toThrow('failed')
    await expect(caller.call('echo', 4)).resolves.toBe(4)
    expect(closed).toEqual([])
  })

  it('a bulk reply over MAX_FRAME_BYTES is refused as failed, and the link stays open', async () => {
    const { client, server } = await linkPair()
    const huge: CallEntry = { bulk: true, run: () => 'x'.repeat(MAX_FRAME_BYTES) }
    const echo: CallEntry = { run: (args) => args }
    const caller = new Calls(client, {})
    new Calls(server, { huge, echo })
    const closed: string[] = []
    client.on('close', (r: string) => closed.push(r))
    server.on('close', (r: string) => closed.push(r))

    await expect(caller.call('huge', {})).rejects.toThrow('failed')
    await expect(caller.call('echo', 6)).resolves.toBe(6)
    expect(closed).toEqual([])
  })
})
