import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import type { AutoUpdaterLike, UpdateBackendOptions } from './update-backend'
import type { UpdaterBackend } from './updater'

/*
 * Updates of the macOS build, which has no Developer ID: Squirrel.Mac, electron-updater's way on macOS, installs
 * only a build signed by one. electron-updater still finds the new version (latest-mac.yml); ClaudeTerm downloads
 * the version's zip itself, checks it against the feed's sha512, unpacks it, and once the app has quit a small
 * script swaps the two bundles and starts the app again. A copy that cannot replace its bundle (run from the disk
 * image, translocated by Gatekeeper, a folder it cannot write) offers the version on its release page instead.
 */

export const RELEASES_URL = 'https://github.com/DmVergasov/ClaudeTerm/releases'

/** the release page of a version, for the Download button */
export function releasePage(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`
}

/** A file the feed names: on the GitHub release of the version, or beside latest-mac.yml of a test feed */
export function feedFileUrl(version: string, name: string, testFeed?: string): string {
  if (testFeed) return new URL(name, testFeed.endsWith('/') ? testFeed : `${testFeed}/`).href
  return `${RELEASES_URL}/download/v${version}/${name}`
}

/** the .app the running program is in: /Applications/ClaudeTerm.app/Contents/MacOS/ClaudeTerm → /Applications/ClaudeTerm.app */
export function bundleOf(execPath: string): string | null {
  const m = /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return m ? m[1] : null
}

/** the zip of this Mac's architecture among the feed's files: electron-builder names the arm64 one …-arm64-mac.zip */
export function pickZip<T extends { url: string }>(files: T[], arch: string): T | null {
  const arm = (f: T): boolean => f.url.includes('arm64')
  return files.find((f) => f.url.endsWith('.zip') && arm(f) === (arch === 'arm64')) ?? null
}

/** Why this copy cannot replace its bundle, or null when it can */
export function selfUpdateBlocker(bundle: string | null, canReplace: (bundle: string) => boolean): string | null {
  if (!bundle) return 'ClaudeTerm runs from something that is not an app bundle'
  if (bundle.includes('/AppTranslocation/')) return 'macOS runs ClaudeTerm from a read-only copy: move it to Applications'
  if (!canReplace(bundle)) return `cannot write ${posix.dirname(bundle)}`
  return null
}

export interface MacUpdateDeps {
  /** the running app's bundle; null in a run that is not one */
  bundle: string | null
  arch: string
  /** whether this user may replace the bundle: write access to it and to its folder */
  canReplace(bundle: string): boolean
  /** the version the swap could not install the last time it ran: it is offered on its release page instead */
  failedVersion: string | null
  /** the address of a file the feed names */
  fileUrl(version: string, name: string): string
  /** downloads and unpacks the zip of a version; resolves the new bundle */
  fetch(version: string, url: string, sha512: string): Promise<string>
  /** replaces the bundle with the new one once the app has quit, then starts the app again */
  swap(app: string, next: string, version: string): void
  quit(): void
}

export function createMacUpdateBackend(u: AutoUpdaterLike, d: MacUpdateDeps, o: Pick<UpdateBackendOptions, 'testFeed' | 'log'>): UpdaterBackend {
  if (o.testFeed) u.setFeedURL({ provider: 'generic', url: o.testFeed })
  u.autoDownload = false
  u.autoInstallOnAppQuit = false
  u.disableWebInstaller = true
  u.logger = {
    info: (m) => o.log.info(`updater: ${String(m)}`),
    warn: (m) => o.log.warn(`updater: ${String(m)}`),
    error: (m) => o.log.error(`updater: ${String(m)}`),
    debug: () => {}
  }
  let downloaded: (version: string, notes: string | null) => void = () => {}
  let offered: (version: string, notes: string | null) => void = () => {}
  /** the version being downloaded, or downloaded */
  let fetching: string | null = null
  let ready: { version: string; app: string } | null = null
  return {
    check: async () => {
      const r = await u.checkForUpdates()
      if (!r?.isUpdateAvailable) return null
      const { version } = r.updateInfo
      const notes = typeof r.updateInfo.releaseNotes === 'string' ? r.updateInfo.releaseNotes : null
      if (fetching === version) return version
      const zip = pickZip(r.updateInfo.files ?? [], d.arch)
      const blocker = selfUpdateBlocker(d.bundle, d.canReplace)
        ?? (d.failedVersion === version ? 'it could not be installed the last time' : null)
        ?? (zip ? null : `the release has no zip for ${d.arch}`)
      if (blocker || !zip) {
        o.log.info(`updater: ${version} is offered on its release page: ${blocker ?? ''}`)
        offered(version, notes)
        return version
      }
      fetching = version
      d.fetch(version, d.fileUrl(version, zip.url), zip.sha512).then((app) => {
        ready = { version, app }
        downloaded(version, notes)
      }, (e: unknown) => {
        fetching = null
        o.log.warn(`updater: cannot download ${version}: ${(e as Error).message}`)
        offered(version, notes)
      })
      return version
    },
    onDownloaded: (cb) => { downloaded = cb },
    onOffered: (cb) => { offered = cb },
    onError: (cb) => { u.on('error', (e) => cb(e.message)) },
    quitAndInstall: () => {
      if (!ready || !d.bundle) return
      d.swap(d.bundle, ready.app, ready.version)
      d.quit()
    }
  }
}

/** Downloads `url` into `file`; a download whose sha512 (base64, as latest-mac.yml has it) differs is deleted and fails. */
export async function downloadVerified(get: (url: string) => Promise<Response>, url: string, file: string, sha512: string): Promise<void> {
  const res = await get(url)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)
  const hash = createHash('sha512')
  const hashing = new Transform({ transform(chunk: Buffer, _enc, cb) { hash.update(chunk); cb(null, chunk) } })
  await pipeline(Readable.fromWeb(res.body as ReadableStream<Uint8Array>), hashing, createWriteStream(file))
  if (hash.digest('base64') !== sha512) {
    await rm(file, { force: true })
    throw new Error('the download does not match its checksum')
  }
}

/** Unpacks a zip made by electron-builder with ditto, which keeps the bundle's links and signature; resolves the .app in it */
export async function unpackZip(zip: string, dir: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/ditto', ['-x', '-k', zip, dir], { timeout: 5 * 60_000 }, (e) => (e ? reject(e) : resolve()))
  })
  const app = (await readdir(dir)).find((n) => n.endsWith('.app'))
  if (!app) throw new Error('the zip holds no .app')
  return join(dir, app)
}

/** A version's bundle, ready for the swap: <stagingDir>/<version>/ClaudeTerm.app. Whatever an earlier update left there goes first. */
export async function prepareUpdate(o: { stagingDir: string; version: string; url: string; sha512: string; get: (url: string) => Promise<Response> }): Promise<string> {
  await rm(o.stagingDir, { recursive: true, force: true })
  const dir = join(o.stagingDir, o.version)
  await mkdir(dir, { recursive: true })
  const zip = join(dir, 'update.zip')
  await downloadVerified(o.get, o.url, zip, o.sha512)
  const app = await unpackZip(zip, dir)
  await rm(zip, { force: true })
  return app
}

/**
 * Waits (a minute at most) for the app to quit, swaps the bundles by renaming them, deletes the old one and starts
 * the app again. When a rename fails the old bundle stays, the version is written to the failure file, and the old app
 * starts again: it then offers the version on its release page.
 */
export const SWAP_SCRIPT = `pid=$1 app=$2 next=$3 failed=$4 version=$5 relaunch=$6
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  [ "$n" -gt 600 ] && exit 1
  sleep 0.1
done
old="$next.old"
if mv "$app" "$old"; then
  if mv "$next" "$app"; then
    rm -rf "$old"
    rmdir "\${next%/*}" 2>/dev/null
    exec "$relaunch" "$app"
  fi
  mv "$old" "$app"
fi
printf '%s' "$version" > "$failed"
exec "$relaunch" "$app"
`

export interface SwapOptions {
  /** the app's process, waited for */
  pid: number
  /** the running app's bundle */
  app: string
  /** the new bundle that takes its place */
  next: string
  version: string
  /** where the version is written when the swap fails */
  failedFile: string
  /** started with the bundle afterwards: /usr/bin/open */
  relaunch: string
}

/** Starts the swap script on its own, so that it outlives the app */
export function startSwap(o: SwapOptions): void {
  spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'claudeterm-update', String(o.pid), o.app, o.next, o.failedFile, o.version, o.relaunch], { detached: true, stdio: 'ignore' }).unref()
}
