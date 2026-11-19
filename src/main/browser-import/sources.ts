import { access, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { findExecutable } from '../login-env'
import { pathKey } from '../path-key'
import type { ImportSourceView } from '../../shared/browser'

export type BrowserKind = 'chrome' | 'edge' | 'brave' | 'vivaldi' | 'chromium' | 'firefox'
type ChromiumKind = Exclude<BrowserKind, 'firefox'>

export interface BrowserBinary {
  file: string
  args: string[]
  env?: Record<string, string>
}

// A browser profile that the import can read cookies from.
export interface ImportSource {
  id: string
  kind: BrowserKind
  browser: string
  label: string
  family: 'chromium' | 'firefox'
  userDataDir: string
  profileDir: string
  profileName: string
  email: string | null
  hasCookies: boolean
  binary: BrowserBinary | null
  // copy: the profile's folder is copied and read; live: the running browser is asked for the cookies of its open profiles
  mode: 'copy' | 'live'
}

// Where to look: the caller passes the platform and the folders, so nothing here reads the real machine.
export interface SourceEnv {
  platform: NodeJS.Platform
  home: string
  appData: string | null
  localAppData: string | null
  programFiles: string[]
  pathVar: string
  isExecutable(path: string): boolean
}

interface Profile {
  dir: string
  name: string
  email: string | null
}

const KIND_ORDER: BrowserKind[] = ['chrome', 'edge', 'brave', 'vivaldi', 'chromium', 'firefox']

const BROWSER_NAMES: Record<BrowserKind, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
  chromium: 'Chromium',
  firefox: 'Firefox',
}

/** Every browser source the machine has: each profile of Chrome, Edge, Brave, Vivaldi and Chromium, then each Firefox profile. */
export async function findSources(env: SourceEnv): Promise<ImportSource[]> {
  const out: ImportSource[] = []
  for (const kind of KIND_ORDER) {
    out.push(...(kind === 'firefox' ? await firefoxSources(env) : await chromiumSources(kind, env)))
  }
  return out
}

/** The sources as the import sheet lists them: one a source can be read from now is available, the others are listed disabled. */
export function sourceViews(sources: ImportSource[]): ImportSourceView[] {
  return sources.map((s) => ({ id: s.id, label: s.label, available: s.hasCookies && (s.family === 'firefox' || s.binary !== null) }))
}

/** The profiles a Chromium user-data folder lists in its Local State, the ones whose folder exists. */
export async function readLocalState(userDataDir: string): Promise<Profile[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(userDataDir, 'Local State'), 'utf8'))
  } catch {
    return []
  }
  const profile = isRecord(parsed) ? parsed.profile : undefined
  const cache = isRecord(profile) ? profile.info_cache : undefined
  if (!isRecord(cache)) return []
  const out: Profile[] = []
  for (const [dir, info] of Object.entries(cache)) {
    if (!isFolderName(dir) || !isRecord(info)) continue
    if (!(await isDirectory(join(userDataDir, dir)))) continue
    const name = typeof info.name === 'string' && info.name !== '' ? info.name : dir
    const email = typeof info.user_name === 'string' && info.user_name !== '' ? info.user_name : null
    out.push({ dir, name, email })
  }
  return out
}

/** The profiles a Firefox profiles.ini lists in its [ProfileN] sections; relative paths resolve against the ini's folder. */
export async function readFirefoxProfiles(iniPath: string): Promise<{ dir: string; name: string }[]> {
  let text: string
  try {
    text = await readFile(iniPath, 'utf8')
  } catch {
    return []
  }
  const sections: Record<string, string>[] = []
  let current: Record<string, string> | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      current = /^Profile\d+$/.test(header[1]) ? {} : null
      if (current) sections.push(current)
      continue
    }
    const eq = line.indexOf('=')
    if (current && eq > 0) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  const out: { dir: string; name: string }[] = []
  for (const s of sections) {
    const path = s.Path
    if (!path) continue
    const dir = s.IsRelative === '1' ? join(dirname(iniPath), path) : path
    if (!isAbsolute(dir)) continue
    out.push({ dir, name: s.Name || basename(dir) })
  }
  return out
}

// On Windows, App-Bound Encryption keeps Chrome, Edge and Brave cookies out of a copy: they are read from the running browser.
const LIVE_KINDS: ChromiumKind[] = ['chrome', 'edge', 'brave']

async function chromiumSources(kind: ChromiumKind, env: SourceEnv): Promise<ImportSource[]> {
  const userDataDir = chromiumUserDataDir(kind, env)
  if (!userDataDir) return []
  if (env.platform === 'win32' && LIVE_KINDS.includes(kind)) {
    if (!(await isDirectory(userDataDir))) return []
    const binary = await findBinary(kind, env)
    return [
      {
        id: `${kind}:open`,
        kind,
        ...displayOf(kind, 'open profiles', null),
        family: 'chromium',
        userDataDir,
        profileDir: userDataDir,
        profileName: '',
        email: null,
        hasCookies: true,
        binary,
        mode: 'live',
      },
    ]
  }
  const profiles = sortByFolder(await readLocalState(userDataDir))
  if (profiles.length === 0) return []
  const binary = await findBinary(kind, env)
  const out: ImportSource[] = []
  for (const p of profiles) {
    const profileDir = join(userDataDir, p.dir)
    out.push({
      id: `${kind}:${p.dir}`,
      kind,
      ...displayOf(kind, p.name, p.email),
      family: 'chromium',
      userDataDir,
      profileDir,
      profileName: p.name,
      email: p.email,
      hasCookies: await exists(join(profileDir, 'Network', 'Cookies')),
      binary,
      mode: 'copy',
    })
  }
  return out
}

/** The page of a browser that turns remote debugging on, shown by the setup step of the live import. */
export function inspectUrl(kind: BrowserKind): string {
  const scheme = kind === 'edge' || kind === 'brave' ? kind : 'chrome'
  return `${scheme}://inspect/#remote-debugging`
}

async function firefoxSources(env: SourceEnv): Promise<ImportSource[]> {
  // A profile can be named by both profiles.ini files of Linux; it is listed once, by its resolved path.
  const found: { iniDir: string; dir: string; name: string }[] = []
  const seen = new Set<string>()
  for (const ini of firefoxIniPaths(env)) {
    for (const p of await readFirefoxProfiles(ini)) {
      const key = pathKey(p.dir)
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ iniDir: dirname(ini), ...p })
    }
  }
  const out: ImportSource[] = []
  for (const p of sortByFolder(found)) {
    out.push({
      id: `firefox:${basename(p.dir)}`,
      kind: 'firefox',
      ...displayOf('firefox', p.name, null),
      family: 'firefox',
      userDataDir: p.iniDir,
      profileDir: p.dir,
      profileName: p.name,
      email: null,
      hasCookies: await exists(join(p.dir, 'cookies.sqlite')),
      binary: null,
      mode: 'copy',
    })
  }
  return out
}

function displayOf(kind: BrowserKind, name: string, email: string | null): { browser: string; label: string } {
  const browser = BROWSER_NAMES[kind]
  return { browser, label: `${browser} · ${name}${email ? ` (${email})` : ''}` }
}

function chromiumUserDataDir(kind: ChromiumKind, env: SourceEnv): string | null {
  if (env.platform === 'win32') {
    if (!env.localAppData) return null
    const folders: Record<ChromiumKind, string[]> = {
      chrome: ['Google', 'Chrome', 'User Data'],
      edge: ['Microsoft', 'Edge', 'User Data'],
      brave: ['BraveSoftware', 'Brave-Browser', 'User Data'],
      vivaldi: ['Vivaldi', 'User Data'],
      chromium: ['Chromium', 'User Data'],
    }
    return join(env.localAppData, ...folders[kind])
  }
  if (env.platform === 'darwin') {
    const folders: Record<ChromiumKind, string[]> = {
      chrome: ['Google', 'Chrome'],
      edge: ['Microsoft Edge'],
      brave: ['BraveSoftware', 'Brave-Browser'],
      vivaldi: ['Vivaldi'],
      chromium: ['Chromium'],
    }
    return join(env.home, 'Library', 'Application Support', ...folders[kind])
  }
  const folders: Record<ChromiumKind, string[]> = {
    chrome: ['google-chrome'],
    edge: ['microsoft-edge'],
    brave: ['BraveSoftware', 'Brave-Browser'],
    vivaldi: ['vivaldi'],
    chromium: ['chromium'],
  }
  return join(env.home, '.config', ...folders[kind])
}

function firefoxIniPaths(env: SourceEnv): string[] {
  if (env.platform === 'win32') return env.appData ? [join(env.appData, 'Mozilla', 'Firefox', 'profiles.ini')] : []
  if (env.platform === 'darwin') return [join(env.home, 'Library', 'Application Support', 'Firefox', 'profiles.ini')]
  return [join(env.home, '.mozilla', 'firefox', 'profiles.ini'), join(env.home, 'snap', 'firefox', 'common', '.mozilla', 'firefox', 'profiles.ini')]
}

async function findBinary(kind: ChromiumKind, env: SourceEnv): Promise<BrowserBinary | null> {
  if (env.platform !== 'win32' && env.platform !== 'darwin') {
    const names: Record<ChromiumKind, string[]> = {
      chrome: ['google-chrome-stable', 'google-chrome'],
      edge: ['microsoft-edge-stable', 'microsoft-edge'],
      brave: ['brave-browser', 'brave'],
      vivaldi: ['vivaldi-stable', 'vivaldi'],
      chromium: ['chromium', 'chromium-browser'],
    }
    for (const name of names[kind]) {
      const file = findExecutable(name, env.pathVar, env.isExecutable)
      if (file) return { file, args: [] }
    }
    return null
  }
  const file = binaryCandidates(kind, env).find((p) => env.isExecutable(p))
  return file ? { file, args: [] } : null
}

function binaryCandidates(kind: ChromiumKind, env: SourceEnv): string[] {
  if (env.platform === 'darwin') {
    const apps: Record<ChromiumKind, string> = {
      chrome: 'Google Chrome',
      edge: 'Microsoft Edge',
      brave: 'Brave Browser',
      vivaldi: 'Vivaldi',
      chromium: 'Chromium',
    }
    const app = apps[kind]
    return ['/Applications', join(env.home, 'Applications')].map((root) => join(root, `${app}.app`, 'Contents', 'MacOS', app))
  }
  const pf = env.programFiles
  const local = env.localAppData
  const under = (base: string | null, ...rest: string[]): string[] => (base ? [join(base, ...rest)] : [])
  switch (kind) {
    case 'chrome':
      return [...pf.map((p) => join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')), ...under(local, 'Google', 'Chrome', 'Application', 'chrome.exe')]
    case 'edge':
      return pf.map((p) => join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    case 'brave':
      return [
        ...pf.map((p) => join(p, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')),
        ...under(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ]
    case 'vivaldi':
      return [...under(local, 'Vivaldi', 'Application', 'vivaldi.exe'), ...pf.map((p) => join(p, 'Vivaldi', 'Application', 'vivaldi.exe'))]
    case 'chromium':
      return under(local, 'Chromium', 'Application', 'chrome.exe')
  }
}

// Default first, then the folder names in numeric order, so Profile 2 comes before Profile 10.
function sortByFolder<T extends { dir: string }>(items: T[]): T[] {
  const name = (t: T): string => basename(t.dir)
  return [...items].sort((a, b) => {
    const x = name(a)
    const y = name(b)
    if (x === y) return 0
    if (x === 'Default') return -1
    if (y === 'Default') return 1
    return x.localeCompare(y, undefined, { numeric: true })
  })
}

function isFolderName(s: string): boolean {
  return s !== '' && s !== '.' && s !== '..' && !/[/\\]/.test(s)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}
