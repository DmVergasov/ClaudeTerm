import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runOffThread } from './off-thread-spawn'

/*
 * The Claude Code version a tab's command runs. ClaudeTerm wakes an idle session with a message only on 2.1.287 or later,
 * so it asks the command once with --version and keeps the answer in claude-version.json for the next start.
 */

const CACHE_FILE = 'claude-version.json'
const VERSION = /^\d+\.\d+\.\d+$/

/** what the last probe asked: the command, and its version or null when it failed */
export interface VersionProbe {
  command: string
  version: string | null
}

/**
 * The version in the output of `claude --version`, e.g. "2.1.322 (Claude Code)" gives "2.1.322". The shell's profile may
 * print first, a version of its own among it ("nvm 0.39.7"): the x.y.z before "(Claude Code)" wins, else the last one.
 */
export function parseClaudeVersion(output: string): string | null {
  const named = /(\d+\.\d+\.\d+) \(Claude Code\)/.exec(output)
  if (named) return named[1]
  const all = output.match(/\d+\.\d+\.\d+/g)
  return all ? all[all.length - 1] : null
}

/** whether version v is min or later, compared part by part as numbers */
export function versionAtLeast(v: string, min: string): boolean {
  if (!VERSION.test(v) || !VERSION.test(min)) return false
  const a = v.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return true
}

/** the last probe, or null when there is none or the file is not valid */
export function readVersionCache(dataDir: string): VersionProbe | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dataDir, CACHE_FILE), 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { command, version } = raw as Record<string, unknown>
  if (typeof command !== 'string' || command.length === 0) return null
  if (version !== null && (typeof version !== 'string' || !VERSION.test(version))) return null
  return { command, version }
}

/** how the probe runs `<command> --version`: as buildProbe gives it for the Claude tabs' shell, optionally with an environment */
export interface ProbeRun {
  file: string
  args: string[]
  verbatim?: boolean
  detached?: boolean
  env?: NodeJS.ProcessEnv
}

async function runVersion(run: ProbeRun, cwd: string): Promise<string | null> {
  try {
    const r = await runOffThread(run.file, run.args, { cwd, env: run.env, verbatim: run.verbatim, detached: run.detached, timeoutMs: 15000, maxOutput: 65536 })
    if (r.code !== 0) return null
    return parseClaudeVersion(r.stdout.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Asks `<command> --version` for its version, caches the answer in dataDir, and resolves null on any failure. Never rejects.
 * It runs as `run` says, in dataDir: a file the command line happens to write lands there, never in the app's folder.
 */
export async function probeClaudeVersion(dataDir: string, command: string, run: ProbeRun): Promise<string | null> {
  let version: string | null = null
  try {
    mkdirSync(dataDir, { recursive: true })
    version = await runVersion(run, dataDir)
  } catch {
    // no data folder to run in: the version is not known
  }
  try {
    writeFileSync(join(dataDir, CACHE_FILE), JSON.stringify({ command, version }), 'utf8')
  } catch {
    // the cache only saves the next start a probe: a failed write is ignored
  }
  return version
}
