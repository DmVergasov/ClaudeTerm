import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importPlatform, importSourceEnv, withTestBinaries } from '../../src/main/browser-import/import-env'
import type { ImportSource } from '../../src/main/browser-import/sources'

const NODE = '/fake/electron'
const isExecutable = (): boolean => false

describe('importSourceEnv', () => {
  it('reads the machine: its folders and its platform, outside a test run', () => {
    const env = importSourceEnv({
      isTest: false,
      env: { CLAUDETERM_TEST_BROWSER_ROOT: '/should/not/be/read', CLAUDETERM_TEST_BROWSER_PLATFORM: 'win32' },
      platform: 'linux',
      home: '/home/person',
      appData: undefined,
      localAppData: undefined,
      programFiles: ['/opt'],
      pathVar: '/usr/bin',
      isExecutable,
    })
    expect(env).toMatchObject({ platform: 'linux', home: '/home/person', appData: null, localAppData: null, programFiles: ['/opt'], pathVar: '/usr/bin' })
  })

  it('has no sources at all in a test run without a browser root', () => {
    expect(importSourceEnv({ isTest: true, env: {}, platform: 'linux', home: '/h', appData: undefined, localAppData: undefined, programFiles: [], pathVar: '', isExecutable })).toBeNull()
  })

  it('reads the folders of the test root in a test run, on the platform the test names', () => {
    const root = join('/tmp', 'ct-root')
    const env = importSourceEnv({
      isTest: true,
      env: { CLAUDETERM_TEST_BROWSER_ROOT: root, CLAUDETERM_TEST_BROWSER_PLATFORM: 'win32' },
      platform: 'linux',
      home: '/home/person',
      appData: undefined,
      localAppData: undefined,
      programFiles: ['/opt'],
      pathVar: '/usr/bin',
      isExecutable,
    })
    expect(env).toEqual({
      platform: 'win32',
      home: join(root, 'home'),
      appData: join(root, 'appdata'),
      localAppData: join(root, 'localappdata'),
      programFiles: [join(root, 'programfiles')],
      pathVar: '',
      isExecutable,
    })
  })

  it('keeps the machine platform in a test run that names none', () => {
    expect(importPlatform(true, { CLAUDETERM_TEST_BROWSER_ROOT: '/r' }, 'darwin')).toBe('darwin')
    expect(importPlatform(true, { CLAUDETERM_TEST_BROWSER_PLATFORM: 'win32' }, 'darwin')).toBe('win32')
    expect(importPlatform(false, { CLAUDETERM_TEST_BROWSER_PLATFORM: 'win32' }, 'darwin')).toBe('darwin')
  })
})

describe('withTestBinaries', () => {
  const base: ImportSource = {
    id: 'chromium:Profile 1',
    kind: 'chromium',
    browser: 'Chromium',
    label: 'Chromium · Work',
    family: 'chromium',
    userDataDir: '/root/localappdata/Chromium/User Data',
    profileDir: '/root/localappdata/Chromium/User Data/Profile 1',
    profileName: 'Work',
    email: null,
    hasCookies: true,
    binary: null,
    mode: 'copy',
  }

  it('runs a copy through the copy stand-in, and a live browser through the devtools stand-in on its folder', () => {
    const [copy, live] = withTestBinaries([base, { ...base, id: 'chrome:open', browser: 'Chrome', mode: 'live', userDataDir: '/root/Chrome/User Data' }], {
      standIn: '/fx/stand-in-browser.mjs',
      devtools: '/fx/stand-in-devtools.mjs',
      node: NODE,
    })
    expect(copy.binary).toEqual({ file: NODE, args: ['/fx/stand-in-browser.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } })
    expect(live.binary).toEqual({ file: NODE, args: ['/fx/stand-in-devtools.mjs', '--user-data-dir=/root/Chrome/User Data'], env: { ELECTRON_RUN_AS_NODE: '1' } })
  })

  it('leaves a source with no stand-in without a binary, and a Firefox source as it is', () => {
    const firefox: ImportSource = { ...base, id: 'firefox:abc', kind: 'firefox', family: 'firefox', binary: null }
    const [copy, ff] = withTestBinaries([base, firefox], { standIn: undefined, devtools: undefined, node: NODE })
    expect(copy.binary).toBeNull()
    expect(ff).toEqual(firefox)
  })
})
