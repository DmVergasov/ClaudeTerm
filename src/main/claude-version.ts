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

/** the first x.y.z in the output of `claude --version`, e.g. "2.1.322 (Claude Code)" gives "2.1.322" */
export function parseClaudeVersion(output: string): string | null {
  const m = /\d+\.\d+\.\d+/.exec(output)
  return m ? m[0] : null
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

async function runVersion(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv | undefined): Promise<string | null> {
  try {
    const r = platform === 'win32'
      // cmd /s strips the outer quotes; verbatim keeps the quoted paths of the command as they are
      ? await runOffThread(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command} --version"`], { verbatim: true, timeoutMs: 15000, maxOutput: 65536, env })
      : await runOffThread('/bin/sh', ['-c', `${command} --version`], { timeoutMs: 15000, maxOutput: 65536, env })
    if (r.code !== 0) return null
    return parseClaudeVersion(r.stdout.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Asks `<command> --version` for its version, caches the answer in dataDir, and resolves null on any failure. Never rejects.
 * env is the environment the command runs with: the PATH of a shell finds a claude that a GUI app's PATH misses.
 */
export async function probeClaudeVersion(dataDir: string, command: string, platform: NodeJS.Platform = process.platform, env?: NodeJS.ProcessEnv): Promise<string | null> {
  const version = await runVersion(command, platform, env)
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, CACHE_FILE), JSON.stringify({ command, version }), 'utf8')
  } catch {
    // the cache only saves the next start a probe: a failed write is ignored
  }
  return version
}
