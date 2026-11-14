// The accounts' test data, shared by the integration tests and the e2e helpers (tests/e2e/account-helpers.ts). Invented
// data only: no real address, organization or token. No Playwright import here, the integration tests use this file too.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { signIn, accountOf } from './fake-claude/fake-cli'

export const WORK = '0b6f3c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'
export const STUDIO = '7e1d2c3b-4a5f-4e6d-9c8b-7a6f5e4d3c2b'
export const CI_BOT = '1c7a4d3f-5e6b-4f7a-9b8c-0d1e2f3a4b5c'
export const CI_TOKEN = 'e2e-token-ci-000000000001'
export const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
export const MAIN_CREDENTIAL = 'main-credential-never-copied-0001'
export const MAIN_WHO = {
  emailAddress: 'main@example.com',
  organizationName: 'Example',
  organizationUuid: '00000000-0000-4000-8000-000000000001',
  organizationType: 'claude_max'
}

/** the account a folder signs in as: the defaults of the stand-in (its name decides), `who` replaces its parts */
export function signedIn(folder: string, who: Partial<typeof MAIN_WHO> = {}): void {
  signIn(folder, { ...accountOf(basename(folder)), ...who })
}

function readObject(file: string): Record<string, any> {
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
}

/** trusts a folder in the config folder's .claude.json, as Claude Code keeps the trust: by the folder's real path */
export function trust(config: string, folder: string): void {
  const file = join(config, '.claude.json')
  const doc = readObject(file)
  doc.projects ??= {}
  const key = realpathSync.native(folder)
  doc.projects[key] = { ...doc.projects[key], hasTrustDialogAccepted: true }
  writeFileSync(file, JSON.stringify(doc))
}

/** the lines of a stand-in log file, parsed; none when there is no file yet */
export function readLog(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** the stand-in's runs (its first log line of each process): the arguments, the config folder and whether a token or a key was set */
export function runs(log: () => Record<string, unknown>[]): { argv: string[]; config: string | null; oauthToken: boolean; apiKey: boolean }[] {
  return log()
    .filter((entry) => entry.argv !== undefined)
    .map((entry) => {
      const env = entry.env as { config: string | null; oauthToken: boolean; apiKey: boolean }
      return { argv: entry.argv as string[], config: env.config, oauthToken: env.oauthToken, apiKey: env.apiKey }
    })
}

/** sha256 over every file's relative path (with `/`) and its bytes, in path order: equal digests mean equal folders */
export function hashTree(dir: string): string {
  const files: string[] = []
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(relative(dir, path).split(sep).join('/'))
    }
  }
  if (existsSync(dir)) walk(dir)
  const hash = createHash('sha256')
  for (const rel of files.sort()) {
    hash.update(rel + '\0')
    hash.update(readFileSync(join(dir, rel)))
  }
  return hash.digest('hex')
}
