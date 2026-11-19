import { join } from 'node:path'
import type { ImportSource, SourceEnv } from './sources'

// Where the import looks for browsers. A test run reads only its own temp root (CLAUDETERM_TEST_BROWSER_ROOT), and with no root
// it reads no browser at all, so a test never reaches the machine's browsers. Outside a test run the machine is read.

/** the platform the import works for: a test run may name another one, so the Windows live path runs on every OS */
export function importPlatform(isTest: boolean, env: Record<string, string | undefined>, platform: NodeJS.Platform): NodeJS.Platform {
  const named = isTest ? env.CLAUDETERM_TEST_BROWSER_PLATFORM : undefined
  return named ? (named as NodeJS.Platform) : platform
}

export interface ImportEnvInput {
  isTest: boolean
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  home: string
  appData: string | undefined
  localAppData: string | undefined
  programFiles: string[]
  pathVar: string
  isExecutable(path: string): boolean
}

/** the folders the sources are looked for in; null in a test run without a root, where there are no sources */
export function importSourceEnv(i: ImportEnvInput): SourceEnv | null {
  if (!i.isTest) {
    return {
      platform: i.platform,
      home: i.home,
      appData: i.appData ?? null,
      localAppData: i.localAppData ?? null,
      programFiles: i.programFiles,
      pathVar: i.pathVar,
      isExecutable: i.isExecutable,
    }
  }
  const root = i.env.CLAUDETERM_TEST_BROWSER_ROOT
  if (!root) return null
  return {
    platform: importPlatform(true, i.env, i.platform),
    home: join(root, 'home'),
    appData: join(root, 'appdata'),
    localAppData: join(root, 'localappdata'),
    programFiles: [join(root, 'programfiles')],
    pathVar: '',
    isExecutable: i.isExecutable,
  }
}

/**
 * In a test run each Chromium source runs a stand-in instead of the browser: a copy is read by the copy stand-in, and a live
 * browser is asked through the devtools stand-in on its own folder. A source without its stand-in has no binary.
 */
export function withTestBinaries(sources: ImportSource[], o: { standIn: string | undefined; devtools: string | undefined; node: string }): ImportSource[] {
  const node = { ELECTRON_RUN_AS_NODE: '1' }
  return sources.map((s) => {
    if (s.family === 'firefox') return s
    if (s.mode === 'live') {
      return o.devtools ? { ...s, binary: { file: o.node, args: [o.devtools, `--user-data-dir=${s.userDataDir}`], env: node } } : { ...s, binary: null }
    }
    return o.standIn ? { ...s, binary: { file: o.node, args: [o.standIn], env: node } } : { ...s, binary: null }
  })
}
