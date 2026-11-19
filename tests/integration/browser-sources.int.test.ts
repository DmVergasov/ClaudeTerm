import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findSources, inspectUrl, readFirefoxProfiles, readLocalState, type SourceEnv } from '../../src/main/browser-import/sources'

// Every folder here is invented and lives in a temp folder of this test; the real browser folders are never read.

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ct-sources-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function touch(p: string, text = ''): void {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}

function localState(profiles: Record<string, { name: string; user_name?: string }>): string {
  return JSON.stringify({ profile: { info_cache: profiles } })
}

function envWith(over: Partial<SourceEnv> & { executables?: string[] }): SourceEnv {
  const executables = new Set(over.executables ?? [])
  return {
    platform: 'win32',
    home: join(root, 'home'),
    appData: join(root, 'AppData', 'Roaming'),
    localAppData: join(root, 'AppData', 'Local'),
    programFiles: [join(root, 'Program Files')],
    pathVar: '',
    isExecutable: (p) => executables.has(p),
    ...over,
  }
}

describe('findSources on the Windows layout', () => {
  it('lists one open-profiles source for Chrome and for Edge, and the Firefox profile as a copy source with its binary', async () => {
    const local = join(root, 'AppData', 'Local')
    const appData = join(root, 'AppData', 'Roaming')
    const pf = join(root, 'Program Files')
    const chromeUD = join(local, 'Google', 'Chrome', 'User Data')
    touch(join(chromeUD, 'Local State'), localState({
      Default: { name: 'Person 1', user_name: '' },
      'Profile 1': { name: 'Work', user_name: 'name@example.com' },
    }))
    touch(join(chromeUD, 'Default', 'Network', 'Cookies'))
    touch(join(chromeUD, 'Profile 1', 'Network', 'Cookies'))
    const edgeUD = join(local, 'Microsoft', 'Edge', 'User Data')
    mkdirSync(edgeUD, { recursive: true })
    touch(join(appData, 'Mozilla', 'Firefox', 'profiles.ini'), [
      '[General]',
      'StartWithLastProfile=1',
      '',
      '[Profile0]',
      'Name=default-release',
      'IsRelative=1',
      'Path=abcd1234.default-release',
      '',
    ].join('\n'))
    touch(join(appData, 'Mozilla', 'Firefox', 'abcd1234.default-release', 'cookies.sqlite'))
    const chromeExe = join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')
    touch(chromeExe)

    const sources = await findSources(envWith({ executables: [chromeExe] }))

    expect(sources).toEqual([
      {
        id: 'chrome:open',
        kind: 'chrome',
        browser: 'Chrome',
        label: 'Chrome · open profiles',
        family: 'chromium',
        userDataDir: chromeUD,
        profileDir: chromeUD,
        profileName: '',
        email: null,
        hasCookies: true,
        binary: { file: chromeExe, args: [] },
        mode: 'live',
      },
      {
        id: 'edge:open',
        kind: 'edge',
        browser: 'Edge',
        label: 'Edge · open profiles',
        family: 'chromium',
        userDataDir: edgeUD,
        profileDir: edgeUD,
        profileName: '',
        email: null,
        hasCookies: true,
        binary: null,
        mode: 'live',
      },
      {
        id: 'firefox:abcd1234.default-release',
        kind: 'firefox',
        browser: 'Firefox',
        label: 'Firefox · default-release',
        family: 'firefox',
        userDataDir: join(appData, 'Mozilla', 'Firefox'),
        profileDir: join(appData, 'Mozilla', 'Firefox', 'abcd1234.default-release'),
        profileName: 'default-release',
        email: null,
        hasCookies: true,
        binary: null,
        mode: 'copy',
      },
    ])
  })

  it('a copy profile with no Network/Cookies is listed with hasCookies false, and a browser with no binary has binary null', async () => {
    const local = join(root, 'AppData', 'Local')
    const vivaldiUD = join(local, 'Vivaldi', 'User Data')
    touch(join(vivaldiUD, 'Local State'), localState({ Default: { name: 'Person 1' } }))
    mkdirSync(join(vivaldiUD, 'Default'), { recursive: true })

    const sources = await findSources(envWith({}))

    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ id: 'vivaldi:Default', browser: 'Vivaldi', label: 'Vivaldi · Person 1', hasCookies: false, binary: null, mode: 'copy' })
  })

  it('a Brave folder is one open-profiles source, even when its Local State lists no profile', async () => {
    const local = join(root, 'AppData', 'Local')
    const braveUD = join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')
    mkdirSync(braveUD, { recursive: true })

    const sources = await findSources(envWith({}))

    expect(sources).toEqual([
      {
        id: 'brave:open',
        kind: 'brave',
        browser: 'Brave',
        label: 'Brave · open profiles',
        family: 'chromium',
        userDataDir: braveUD,
        profileDir: braveUD,
        profileName: '',
        email: null,
        hasCookies: true,
        binary: null,
        mode: 'live',
      },
    ])
  })

  it('a listed profile whose folder does not exist is skipped, and a Local State that does not parse is skipped', async () => {
    const local = join(root, 'AppData', 'Local')
    const vivaldiUD = join(local, 'Vivaldi', 'User Data')
    touch(join(vivaldiUD, 'Local State'), localState({ Default: { name: 'Person 1' }, 'Profile 9': { name: 'Gone' } }))
    mkdirSync(join(vivaldiUD, 'Default'), { recursive: true })
    const chromiumUD = join(local, 'Chromium', 'User Data')
    touch(join(chromiumUD, 'Local State'), '{ this is not json')

    const sources = await findSources(envWith({}))

    expect(sources.map((s) => s.id)).toEqual(['vivaldi:Default'])
  })

  it('orders the browsers chrome, edge, brave, vivaldi, chromium, firefox, and the copy profiles with Default first and numeric folder names', async () => {
    const local = join(root, 'AppData', 'Local')
    const chromeUD = join(local, 'Google', 'Chrome', 'User Data')
    mkdirSync(chromeUD, { recursive: true })
    const vivaldiUD = join(local, 'Vivaldi', 'User Data')
    touch(join(vivaldiUD, 'Local State'), localState({
      'Profile 10': { name: 'Ten' },
      'Profile 2': { name: 'Two' },
      Default: { name: 'Zero' },
    }))
    for (const dir of ['Profile 10', 'Profile 2', 'Default']) mkdirSync(join(vivaldiUD, dir), { recursive: true })
    const edgeUD = join(local, 'Microsoft', 'Edge', 'User Data')
    mkdirSync(edgeUD, { recursive: true })

    const sources = await findSources(envWith({}))

    expect(sources.map((s) => s.id)).toEqual(['chrome:open', 'edge:open', 'vivaldi:Default', 'vivaldi:Profile 2', 'vivaldi:Profile 10'])
  })

  it('finds the Windows binaries under Program Files and under the local app data folder', async () => {
    const local = join(root, 'AppData', 'Local')
    const pf = join(root, 'Program Files')
    const pf86 = join(root, 'Program Files (x86)')
    const edgeUD = join(local, 'Microsoft', 'Edge', 'User Data')
    touch(join(edgeUD, 'Local State'), localState({ Default: { name: 'E' } }))
    mkdirSync(join(edgeUD, 'Default'), { recursive: true })
    const edgeExe = join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    const vivaldiExe = join(local, 'Vivaldi', 'Application', 'vivaldi.exe')
    const braveUD = join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')
    touch(join(braveUD, 'Local State'), localState({ Default: { name: 'B' } }))
    mkdirSync(join(braveUD, 'Default'), { recursive: true })
    const braveExe = join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    const env = envWith({ programFiles: [pf, pf86], executables: [edgeExe, vivaldiExe, braveExe] })

    const sources = await findSources(env)

    expect(sources.find((s) => s.kind === 'edge')?.binary).toEqual({ file: edgeExe, args: [] })
    expect(sources.find((s) => s.kind === 'brave')?.binary).toEqual({ file: braveExe, args: [] })
  })
})

describe('findSources looks for a binary only where the browser has a folder', () => {
  it('never checks a binary path when no browser folder exists (isExecutable is a synchronous stat)', async () => {
    const checked: string[] = []

    const sources = await findSources(envWith({ isExecutable: (p) => (checked.push(p), false) }))

    expect(sources).toEqual([])
    expect(checked).toEqual([])
  })
})

describe('findSources on the macOS layout', () => {
  it('reads the Application Support folders and finds the app binary in /Applications', async () => {
    const home = join(root, 'home')
    const chromeUD = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    touch(join(chromeUD, 'Local State'), localState({ Default: { name: 'Person 1' } }))
    mkdirSync(join(chromeUD, 'Default'), { recursive: true })
    const ffProfile = join(home, 'Library', 'Application Support', 'Firefox', 'Profiles', 'x1.default')
    touch(join(home, 'Library', 'Application Support', 'Firefox', 'profiles.ini'), '[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/x1.default\n')
    mkdirSync(ffProfile, { recursive: true })
    const chromeApp = join('/Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')

    const sources = await findSources(envWith({ platform: 'darwin', executables: [chromeApp] }))

    expect(sources.map((s) => [s.id, s.binary?.file ?? null, s.hasCookies, s.mode])).toEqual([
      ['chrome:Default', chromeApp, false, 'copy'],
      ['firefox:x1.default', null, false, 'copy'],
    ])
  })
})

describe('findSources on the Linux layout', () => {
  it('reads the .config folders, lists a Firefox profile once when both profiles.ini files name it, and finds the binary on PATH', async () => {
    const home = join(root, 'home')
    const chromeUD = join(home, '.config', 'google-chrome')
    touch(join(chromeUD, 'Local State'), localState({ Default: { name: 'Person 1' } }))
    mkdirSync(join(chromeUD, 'Default'), { recursive: true })
    // the snap ini names the same profile folder by its absolute path
    touch(join(home, '.mozilla', 'firefox', 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=prof.default-release\n')
    touch(join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox', 'profiles.ini'), `[Profile0]\nName=default-release\nIsRelative=0\nPath=${join(home, '.mozilla', 'firefox', 'prof.default-release')}\n`)
    touch(join(home, '.mozilla', 'firefox', 'prof.default-release', 'cookies.sqlite'))
    const chromeBin = '/opt/ct-test-bin/google-chrome-stable'

    const sources = await findSources(envWith({ platform: 'linux', home, appData: null, localAppData: null, programFiles: [], pathVar: '/usr/bin:/opt/ct-test-bin', executables: [chromeBin] }))

    expect(sources.map((s) => [s.id, s.binary, s.mode])).toEqual([
      ['chrome:Default', { file: chromeBin, args: [] }, 'copy'],
      ['firefox:prof.default-release', null, 'copy'],
    ])
  })

  it('lists each Chrome profile as a copy source, not one open-profiles source', async () => {
    const home = join(root, 'home')
    const chromeUD = join(home, '.config', 'google-chrome')
    touch(join(chromeUD, 'Local State'), localState({ Default: { name: 'Person 1' }, 'Profile 1': { name: 'Work' } }))
    mkdirSync(join(chromeUD, 'Default'), { recursive: true })
    mkdirSync(join(chromeUD, 'Profile 1'), { recursive: true })

    const sources = await findSources(envWith({ platform: 'linux', home, appData: null, localAppData: null, programFiles: [], pathVar: '' }))

    expect(sources.map((s) => [s.id, s.mode])).toEqual([
      ['chrome:Default', 'copy'],
      ['chrome:Profile 1', 'copy'],
    ])
  })
})

describe('inspectUrl', () => {
  it('is the remote debugging page of the browser itself', () => {
    expect(inspectUrl('chrome')).toBe('chrome://inspect/#remote-debugging')
    expect(inspectUrl('edge')).toBe('edge://inspect/#remote-debugging')
    expect(inspectUrl('brave')).toBe('brave://inspect/#remote-debugging')
  })
})

describe('readLocalState', () => {
  it('returns the profiles that have a folder, with an email only when user_name is set', async () => {
    const ud = join(root, 'UD')
    touch(join(ud, 'Local State'), localState({
      Default: { name: 'Person 1', user_name: '' },
      'Profile 1': { name: 'Work', user_name: 'name@example.com' },
      'Profile 3': { name: 'Missing folder' },
    }))
    mkdirSync(join(ud, 'Default'), { recursive: true })
    mkdirSync(join(ud, 'Profile 1'), { recursive: true })

    expect(await readLocalState(ud)).toEqual([
      { dir: 'Default', name: 'Person 1', email: null },
      { dir: 'Profile 1', name: 'Work', email: 'name@example.com' },
    ])
  })

  it('returns nothing for a folder without Local State or without info_cache', async () => {
    const ud = join(root, 'UD')
    expect(await readLocalState(ud)).toEqual([])
    touch(join(ud, 'Local State'), JSON.stringify({ browser: {} }))
    expect(await readLocalState(ud)).toEqual([])
  })
})

describe('readFirefoxProfiles', () => {
  it('reads [ProfileN] sections, resolves relative paths against the ini folder and keeps absolute ones', async () => {
    const dir = join(root, 'Firefox')
    const ini = join(dir, 'profiles.ini')
    touch(ini, [
      '[General]',
      'StartWithLastProfile=1',
      'this line has no equals sign',
      '[Profile0]',
      'Name=default-release',
      'IsRelative=1',
      'Path=Profiles/abc.default-release',
      '[Profile1]',
      'Name=Work',
      'IsRelative=0',
      `Path=${join(root, 'elsewhere', 'work.profile')}`,
      '[Install4F96D1932A9F858E]',
      'Default=Profiles/abc.default-release',
      '[Profile2]',
      'Name=No path',
      'IsRelative=1',
      '',
    ].join('\n'))

    expect(await readFirefoxProfiles(ini)).toEqual([
      { dir: join(dir, 'Profiles', 'abc.default-release'), name: 'default-release' },
      { dir: join(root, 'elsewhere', 'work.profile'), name: 'Work' },
    ])
  })

  it('returns nothing when the ini is missing', async () => {
    expect(await readFirefoxProfiles(join(root, 'nope', 'profiles.ini'))).toEqual([])
  })
})
