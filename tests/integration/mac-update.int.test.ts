import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadVerified, prepareUpdate, startSwap } from '../../src/main/mac-update'
import { MAC, WIN } from '../fixtures/platform'

const sha512 = (b: Buffer): string => createHash('sha512').update(b).digest('base64')

let server: Server | null = null
afterEach(() => { server?.close(); server = null })

/** serves `body` at /<name>; anything else is a 404 */
async function serve(name: string, body: Buffer): Promise<string> {
  server = createServer((req, res) => {
    if (req.url === `/${name}`) res.end(body)
    else res.writeHead(404).end()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/${name}`
}

describe('downloadVerified', () => {
  it('writes the download when its sha512 matches the feed\'s', async () => {
    const body = Buffer.from('a zip of ClaudeTerm 0.6.0')
    const url = await serve('ClaudeTerm-0.6.0-mac.zip', body)
    const file = join(mkdtempSync(join(tmpdir(), 'ct-dl-')), 'update.zip')
    await downloadVerified(fetch, url, file, sha512(body))
    expect(readFileSync(file)).toEqual(body)
  })

  it('deletes a download whose sha512 differs, and fails; a missing file fails too', async () => {
    const url = await serve('ClaudeTerm-0.6.0-mac.zip', Buffer.from('tampered'))
    const file = join(mkdtempSync(join(tmpdir(), 'ct-dl-')), 'update.zip')
    await expect(downloadVerified(fetch, url, file, sha512(Buffer.from('the real zip')))).rejects.toThrow('does not match its checksum')
    expect(existsSync(file)).toBe(false)
    await expect(downloadVerified(fetch, url.replace('mac.zip', 'other.zip'), file, 'x')).rejects.toThrow('HTTP 404')
  })
})

/** two bundles, a process standing in for the app, and a stand-in for `open` that notes what it was given */
function swapSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-swap-'))
  const app = join(dir, 'Applications', 'ClaudeTerm.app')
  const next = join(dir, 'update', '0.6.0', 'ClaudeTerm.app')
  for (const [bundle, version] of [[app, 'old'], [next, 'new']]) {
    mkdirSync(join(bundle, 'Contents'), { recursive: true })
    writeFileSync(join(bundle, 'Contents', 'version'), version)
  }
  const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], { stdio: 'ignore' })
  const relaunch = join(dir, 'open')
  writeFileSync(relaunch, `#!/bin/sh\nif kill -0 ${running.pid} 2>/dev/null; then s=running; else s=gone; fi\nprintf '%s %s' "$s" "$1" > '${join(dir, 'relaunched')}'\n`)
  chmodSync(relaunch, 0o755)
  const failedFile = join(dir, 'update-failed.txt')
  const relaunched = (): string | null => (existsSync(join(dir, 'relaunched')) ? readFileSync(join(dir, 'relaunched'), 'utf8') : null)
  const swap = (): void => startSwap({ pid: running.pid!, app, next, version: '0.6.0', failedFile, relaunch })
  return { dir, app, next, failedFile, relaunched, swap }
}

describe.runIf(!WIN)('the swap script', () => {
  it('waits for the app to quit, puts the new bundle in place of the old, deletes the old one and starts the app again', async () => {
    const s = swapSetup()
    s.swap()
    await vi.waitFor(() => expect(s.relaunched()).not.toBeNull(), { timeout: 10_000 })
    expect(s.relaunched()).toBe(`gone ${s.app}`)
    expect(readFileSync(join(s.app, 'Contents', 'version'), 'utf8')).toBe('new')
    expect(existsSync(`${s.next}.old`)).toBe(false)
    expect(existsSync(join(s.dir, 'update', '0.6.0'))).toBe(false)
    expect(existsSync(s.failedFile)).toBe(false)
  })

  it('when the bundle cannot be moved it keeps the old one, notes the version and starts the old app again', async () => {
    if (process.getuid?.() === 0) return // root may move anything
    const s = swapSetup()
    chmodSync(join(s.dir, 'Applications'), 0o555)
    try {
      s.swap()
      await vi.waitFor(() => expect(s.relaunched()).not.toBeNull(), { timeout: 10_000 })
      expect(s.relaunched()).toBe(`gone ${s.app}`)
      expect(readFileSync(join(s.app, 'Contents', 'version'), 'utf8')).toBe('old')
      expect(readFileSync(s.failedFile, 'utf8')).toBe('0.6.0')
    } finally {
      chmodSync(join(s.dir, 'Applications'), 0o755)
    }
  })
})

describe.runIf(MAC)('prepareUpdate on macOS', () => {
  it('downloads the zip, checks it, unpacks the bundle with ditto and drops the zip; an earlier update\'s leftovers go first', async () => {
    const src = mkdtempSync(join(tmpdir(), 'ct-zip-'))
    const bundle = join(src, 'ClaudeTerm.app')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(bundle, 'Contents', 'MacOS', 'ClaudeTerm'), '#!/bin/sh\n')
    chmodSync(join(bundle, 'Contents', 'MacOS', 'ClaudeTerm'), 0o755)
    const zip = join(src, 'ClaudeTerm-0.6.0-mac.zip')
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, zip])
    const body = readFileSync(zip)
    const url = await serve('ClaudeTerm-0.6.0-mac.zip', body)
    const stagingDir = join(mkdtempSync(join(tmpdir(), 'ct-staging-')), 'update')
    mkdirSync(join(stagingDir, '0.5.9', 'ClaudeTerm.app.old'), { recursive: true })
    const app = await prepareUpdate({ stagingDir, version: '0.6.0', url, sha512: sha512(body), get: fetch })
    expect(app).toBe(join(stagingDir, '0.6.0', 'ClaudeTerm.app'))
    expect(readFileSync(join(app, 'Contents', 'MacOS', 'ClaudeTerm'), 'utf8')).toBe('#!/bin/sh\n')
    expect(existsSync(join(stagingDir, '0.6.0', 'update.zip'))).toBe(false)
    expect(existsSync(join(stagingDir, '0.5.9'))).toBe(false)
  })
})
