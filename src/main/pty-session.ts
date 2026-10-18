import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** runs a program and resolves its exit code */
export type ExitCodeRunner = (file: string, args: string[]) => Promise<number>

const exitCode: ExitCodeRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 1000 }, (e) => {
    if (!e) resolve(0)
    else if (typeof e.code === 'number') resolve(e.code)
    else reject(e)
  })
})

/** State and session id from a /proc/<pid>/stat line; the program name in parentheses may hold spaces and ')'. */
export function parseStat(stat: string): { state: string; session: number } | null {
  const end = stat.lastIndexOf(')')
  if (end < 0) return null
  // after the name: state ppid pgrp session …
  const f = stat.slice(end + 2).split(' ')
  const session = Number(f[3])
  return f[0] && Number.isInteger(session) ? { state: f[0], session } : null
}

/** Whether a live (not zombie) process still belongs to the session. Reads /proc: false where there is none. */
export function sessionAlive(sid: number, proc = '/proc'): boolean {
  let names: string[]
  try {
    names = readdirSync(proc)
  } catch {
    return false
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    let line: string
    try {
      line = readFileSync(join(proc, n, 'stat'), 'utf8')
    } catch {
      continue // the process is gone
    }
    const s = parseStat(line)
    if (s && s.session === sid && s.state !== 'Z') return true
  }
  return false
}

/** Where there is no /proc (macOS): whether pgrep finds a process of the session. It exits with 1 when it finds none; a failure counts as none. */
export async function sessionAliveByPgrep(sid: number, run: ExitCodeRunner = exitCode): Promise<boolean> {
  try {
    return (await run('pgrep', ['-s', String(sid)])) === 0
  } catch {
    return false
  }
}

/** /proc on Linux, pgrep elsewhere */
export const sessionAliveHere = (sid: number): boolean | Promise<boolean> => (process.platform === 'linux' ? sessionAlive(sid) : sessionAliveByPgrep(sid))

/** Resolves once the session has no live process, or after timeoutMs. */
export async function waitSessionGone(sid: number, timeoutMs: number, alive: (sid: number) => boolean | Promise<boolean> = sessionAliveHere, stepMs = 100): Promise<void> {
  const until = Date.now() + timeoutMs
  while ((await alive(sid)) && Date.now() < until) await new Promise((r) => setTimeout(r, stepMs))
}
