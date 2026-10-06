import * as pty from 'node-pty'
import { waitSessionGone } from './pty-session'

/** how long a killed tab's programs get to quit after SIGHUP before its PTY counts as exited (not Windows) */
export const SESSION_EXIT_WAIT_MS = 2000

export interface PtyHandle {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface SpawnOptions {
  file: string
  args: string[] | string
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  onData(data: string): void
  onExit(exitCode: number): void
}

export type SpawnPty = (opts: SpawnOptions) => PtyHandle

const running = new Set<Promise<void>>()

/** Resolves when every spawned PTY has exited, or after timeoutMs. */
export function allPtysExited(timeoutMs: number): Promise<void> {
  return Promise.race([Promise.all(running).then(() => undefined), new Promise<void>((r) => setTimeout(r, timeoutMs))])
}

export const spawnPty: SpawnPty = (o) => {
  const p = pty.spawn(o.file, o.args, {
    name: 'xterm-256color',
    cols: Math.max(o.cols, 2),
    rows: Math.max(o.rows, 1),
    cwd: o.cwd,
    env: o.env,
    useConpty: true
  })
  let alive = true
  let killed = false
  let markExited = (): void => {}
  const exited = new Promise<void>((r) => { markExited = r })
  running.add(exited)
  void exited.then(() => running.delete(exited))
  p.onData(o.onData)
  p.onExit(({ exitCode }) => {
    alive = false
    const report = (): void => {
      markExited()
      o.onExit(exitCode)
    }
    // ConPTY ends every program of the console at once. Elsewhere SIGHUP reaches the shell and the programs it ran
    // (claude) take a moment to save and quit: wait for them, so a restart never overlaps them.
    if (killed && process.platform !== 'win32') void waitSessionGone(p.pid, SESSION_EXIT_WAIT_MS).then(report)
    else report()
  })
  return {
    pid: p.pid,
    write: (d) => { if (alive) p.write(d) },
    resize: (c, r) => { if (alive) p.resize(Math.max(c, 2), Math.max(r, 1)) },
    kill: () => {
      if (!alive) return
      alive = false
      killed = true
      try { p.kill() } catch { /* process already gone */ }
    }
  }
}
