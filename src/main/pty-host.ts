import * as pty from 'node-pty'

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
  p.onData(o.onData)
  p.onExit(({ exitCode }) => {
    alive = false
    o.onExit(exitCode)
  })
  return {
    pid: p.pid,
    write: (d) => { if (alive) p.write(d) },
    resize: (c, r) => { if (alive) p.resize(Math.max(c, 2), Math.max(r, 1)) },
    kill: () => {
      if (!alive) return
      alive = false
      try { p.kill() } catch { /* process already gone */ }
    }
  }
}
