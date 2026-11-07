// @peculiar/x509 needs a Reflect polyfill loaded before it: this import comes first
import 'reflect-metadata'
import { createHash, createPrivateKey, randomBytes, randomUUID, webcrypto, X509Certificate } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cryptoProvider, X509CertificateGenerator } from '@peculiar/x509'
import { isUuid } from '../../shared/protocol'
import type { Vault } from '../accounts'
import { isPlainObject } from './views'

const DAY_MS = 24 * 60 * 60 * 1000

/** This device's identity: the id, the self-signed certificate and its private key, as PEM. */
export interface DeviceIdentity {
  id: string
  certPem: string
  keyPem: string
  /** lowercase hex SHA-256 of the certificate's public key (SPKI DER): what a paired device checks */
  fingerprint: string
}

export interface IdentityStoreOptions {
  onError?(message: string): void
  /** what the user is told: the identity could not be read and was replaced */
  warn?(message: string): void
}

/** The identity of this device, kept in device-identity.json with the private key encrypted when the system keyring can. */
export function fingerprintOf(cert: X509Certificate): string {
  return createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
}

/** A new identity: an ECDSA P-256 key pair and a self-signed certificate for it. */
export async function createIdentity(): Promise<DeviceIdentity> {
  cryptoProvider.set(webcrypto as unknown as Crypto)
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const serial = randomBytes(16)
  serial[0] &= 0x7f
  const now = Date.now()
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: serial.toString('hex'),
    name: 'CN=ClaudeTerm device',
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + 30 * 365 * DAY_MS),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys
  })
  const certPem = cert.toString('pem')
  const keyPem = pemOf('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
  return { id: randomUUID(), certPem, keyPem, fingerprint: fingerprintOf(new X509Certificate(certPem)) }
}

function pemOf(label: string, der: ArrayBuffer): string {
  const body = Buffer.from(der).toString('base64').match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

const LOCKED_KEY = "This device's key could not be decrypted by the system keyring; device sync stays off until it can be, or until device-identity.json is deleted to give this device a new key"

/**
 * Reads the identity file: the identity when the text has its shape and the key matches the certificate; null when the
 * file is not an identity. A key the vault cannot decrypt throws: that file is an identity, and it is left as it is.
 */
function parseIdentity(text: string, vault: Vault): DeviceIdentity | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(raw) || raw.version !== 1 || !isUuid(raw.id) || typeof raw.cert !== 'string') return null
  if (!isPlainObject(raw.key) || typeof raw.key.encrypted !== 'boolean' || typeof raw.key.data !== 'string') return null
  let keyPem: string
  if (raw.key.encrypted) {
    try {
      keyPem = vault.decrypt(raw.key.data)
    } catch {
      throw new Error(LOCKED_KEY)
    }
  } else {
    keyPem = raw.key.data
  }
  try {
    const cert = new X509Certificate(raw.cert)
    if (!cert.checkPrivateKey(createPrivateKey(keyPem))) return null
    return { id: raw.id, certPem: raw.cert, keyPem, fingerprint: fingerprintOf(cert) }
  } catch {
    return null
  }
}

/** The device identity in the data folder: created on first use, and replaced when the file cannot be used. */
export class IdentityStore {
  readonly path: string

  constructor(dir: string, private readonly vault: Vault, private readonly opts: IdentityStoreOptions = {}) {
    this.path = join(dir, 'device-identity.json')
  }

  /** Whether the private key is stored encrypted. */
  keyring(): boolean {
    return this.vault.available()
  }

  /** The stored identity; a new one is created and saved when there is no file, or when the file cannot be used. */
  async load(): Promise<DeviceIdentity> {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.reset()
      this.opts.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      return this.replaceUnusable()
    }
    const id = parseIdentity(text, this.vault)
    if (id) return id
    return this.replaceUnusable()
  }

  /** A new identity, saved in place of the stored one. */
  async reset(): Promise<DeviceIdentity> {
    const id = await createIdentity()
    this.save(id)
    return id
  }

  /**
   * The file that cannot be used is kept beside the new one, as `.corrupt-<ms>`; then a new identity replaces it. When it
   * cannot be kept, nothing is saved and the load fails: the file is never written over.
   */
  private async replaceUnusable(): Promise<DeviceIdentity> {
    const aside = `${this.path}.corrupt-${Date.now()}`
    try {
      renameSync(this.path, aside)
    } catch (e) {
      throw new Error(`cannot move ${this.path} aside, so it was not replaced: ${(e as Error).message}`)
    }
    const id = await this.reset()
    this.opts.warn?.("This device's key could not be read; it was given a new one and has to be paired again")
    return id
  }

  private save(id: DeviceIdentity): void {
    const key = this.vault.available()
      ? { encrypted: true, data: this.vault.encrypt(id.keyPem) }
      : { encrypted: false, data: id.keyPem }
    const text = JSON.stringify({ version: 1, id: id.id, cert: id.certPem, key }, null, 2)
    const tmp = `${this.path}.tmp`
    // a temporary file left by a crash may have other permissions: the mode applies only to a new file
    rmSync(tmp, { force: true })
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
