import { once } from 'node:events'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as tls from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isUuid } from '../../src/shared/protocol'
import { createIdentity, fingerprintOf, IdentityStore } from '../../src/main/sync/identity'
import { WIN } from '../fixtures/platform'
import { fakeVault, identities, tempDir } from '../fixtures/sync'

const WARNING = "This device's key could not be read; it was given a new one and has to be paired again"
const LOCKED = "This device's key could not be decrypted by the system keyring; device sync stays off until it can be, or until device-identity.json is deleted to give this device a new key"

const servers: tls.Server[] = []
const sockets: tls.TLSSocket[] = []

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

describe('device identity', () => {
  it('creates an identity once and loads the same one next time', async () => {
    const dir = tempDir('identity')
    const a = await new IdentityStore(dir, fakeVault()).load()
    const b = await new IdentityStore(dir, fakeVault()).load()
    expect(b).toEqual(a)
    expect(a.id).toSatisfy(isUuid)
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the private key is stored encrypted when the vault can, as it is otherwise', async () => {
    const encryptedStore = new IdentityStore(tempDir('identity-enc'), fakeVault(true))
    await encryptedStore.load()
    const encrypted = JSON.parse(readFileSync(encryptedStore.path, 'utf8'))
    expect(encrypted.key).toEqual({ encrypted: true, data: expect.stringMatching(/^enc:-----BEGIN PRIVATE KEY-----/) })
    expect(encryptedStore.keyring()).toBe(true)

    const plainStore = new IdentityStore(tempDir('identity-plain'), fakeVault(false))
    await plainStore.load()
    const plain = JSON.parse(readFileSync(plainStore.path, 'utf8'))
    expect(plain.key).toEqual({ encrypted: false, data: expect.stringMatching(/^-----BEGIN PRIVATE KEY-----/) })
    expect(plainStore.keyring()).toBe(false)
  })

  it.skipIf(WIN)('the file is readable only by the user', async () => {
    const store = new IdentityStore(tempDir('identity-mode'), fakeVault())
    await store.load()
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
  })

  it('a file that cannot be read gives a new identity and a warning', async () => {
    const dir = tempDir('identity-garbage')
    writeFileSync(join(dir, 'device-identity.json'), 'not json {')
    const warn = vi.fn()
    const id = await new IdentityStore(dir, fakeVault(), { warn }).load()
    expect(id.id).toSatisfy(isUuid)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(WARNING)
    expect(readdirSync(dir).some((f) => f.startsWith('device-identity.json.corrupt-'))).toBe(true)
    expect(await new IdentityStore(dir, fakeVault()).load()).toEqual(id)
  })

  it('a file of the wrong shape gives a new identity and a warning', async () => {
    const dir = tempDir('identity-shape')
    writeFileSync(join(dir, 'device-identity.json'), JSON.stringify({ version: 1, id: 'nope' }))
    const warn = vi.fn()
    const id = await new IdentityStore(dir, fakeVault(), { warn }).load()
    expect(id.id).toSatisfy(isUuid)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(WARNING)
  })

  it('a key the vault cannot decrypt rejects and leaves the file as it is; a working vault gets the original back', async () => {
    const dir = tempDir('identity-decrypt')
    const store = new IdentityStore(dir, fakeVault(true))
    const original = await store.load()
    const before = readFileSync(store.path)
    const broken = {
      ...fakeVault(true),
      decrypt: (): string => {
        throw new Error('locked')
      }
    }
    const warn = vi.fn()
    const err = await new IdentityStore(dir, broken, { warn }).load().catch((e: unknown) => e)
    expect((err as Error).message).toBe(LOCKED)
    expect(readFileSync(store.path).equals(before)).toBe(true)
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    expect(await new IdentityStore(dir, fakeVault(true)).load()).toEqual(original)
  })

  it('a file that cannot be moved aside is not replaced: load rejects, the file is unchanged, no warning', async () => {
    const dir = tempDir('identity-stuck')
    const path = join(dir, 'device-identity.json')
    writeFileSync(path, 'not json {')
    const original = readFileSync(path)
    // the move-aside target already exists as a directory, so renaming the file onto it fails on every platform
    const fixed = 1700000000000
    mkdirSync(`${path}.corrupt-${fixed}`)
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixed)
    try {
      const warn = vi.fn()
      const err = await new IdentityStore(dir, fakeVault(), { warn }).load().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(new RegExp(`^cannot move .*device-identity\\.json aside`))
      expect(readFileSync(path).equals(original)).toBe(true)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('a certificate that does not parse gives a new identity and a warning', async () => {
    const dir = tempDir('identity-pem')
    const original = await new IdentityStore(dir, fakeVault(false)).load()
    const path = join(dir, 'device-identity.json')
    const file = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...file, cert: 'not a certificate' }))
    const warn = vi.fn()
    const id = await new IdentityStore(dir, fakeVault(false), { warn }).load()
    expect(id.id).not.toBe(original.id)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(WARNING)
  })

  it('reset gives a new id and a new key, and load returns the reset one afterwards', async () => {
    const dir = tempDir('identity-reset')
    const store = new IdentityStore(dir, fakeVault())
    const before = await store.load()
    const after = await store.reset()
    expect(after.id).not.toBe(before.id)
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(await new IdentityStore(dir, fakeVault()).load()).toEqual(after)
  })

  it('the fingerprint is the one a TLS 1.3 peer sees for the certificate', async () => {
    const [id] = await identities(1)
    const server = tls.createServer({ key: id.keyPem, cert: id.certPem, minVersion: 'TLSv1.3' }, (s) => s.end())
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as { port: number }
    const sock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
    sockets.push(sock)
    await once(sock, 'secureConnect')
    expect(fingerprintOf(sock.getPeerX509Certificate()!)).toBe(id.fingerprint)
  })

  it('createIdentity makes a certificate and key in PEM', async () => {
    const id = await createIdentity()
    expect(id.certPem).toContain('-----BEGIN CERTIFICATE-----')
    expect(id.keyPem).toContain('-----BEGIN PRIVATE KEY-----')
  })
})
