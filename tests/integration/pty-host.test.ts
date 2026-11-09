import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { type PtyHandle, spawnPty } from '../../src/main/pty-host'
import { WIN } from '../fixtures/platform'

const env = process.env as Record<string, string>

/**
 * Answers as a terminal does when the bundled ConPTY asks what it is (ESC [ c). Without an answer it waits about 3 s
 * before the program's first output; in the app xterm answers.
 */
function answerTerminalQuestion(d: string, h: PtyHandle): void {
  if (d.includes('\x1b[c')) h.write('\x1b[?1;2c')
}

/** a process's running children as "pid name", the name lower case */
function children(pid: number): string[] {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`], { encoding: 'utf8' })
  return out.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
}

describe('spawnPty', () => {
  it.runIf(WIN)('runs a process and reports output and exit code', async () => {
    let out = ''
    const code = await new Promise<number>((resolve) => {
      spawnPty({ file: 'cmd.exe', args: ['/c', 'echo pty-ok'], cwd: process.cwd(), env, cols: 80, rows: 24, onData: (d) => { out += d }, onExit: resolve })
    })
    expect(code).toBe(0)
    await vi.waitFor(() => expect(out).toContain('pty-ok'))
  })

  it.runIf(WIN)('accepts a pre-built command line string', async () => {
    let out = ''
    await new Promise<number>((resolve) => {
      spawnPty({ file: 'cmd.exe', args: '/c echo "quoted arg"', cwd: process.cwd(), env, cols: 80, rows: 24, onData: (d) => { out += d }, onExit: resolve })
    })
    await vi.waitFor(() => expect(out).toContain('"quoted arg"'))
  })

  // the console host is the process ConPTY starts beside the program, a child of the process that opens the PTY
  it.runIf(WIN)("runs in the console host it is given: the one bundled with node-pty, or Windows' own", async () => {
    // the names of the processes the PTY added: a console host an earlier test started may still be closing
    const hosts = async (bundledConpty: boolean): Promise<string[]> => {
      const before = new Set(children(process.pid))
      let out = ''
      const h = spawnPty({ file: 'cmd.exe', args: ['/k', 'echo host-up'], cwd: process.cwd(), env, cols: 80, rows: 24, bundledConpty, onData: (d) => { out += d; answerTerminalQuestion(d, h) }, onExit: () => {} })
      try {
        await vi.waitFor(() => expect(out).toContain('host-up'), { timeout: 10_000 })
        return children(process.pid).filter((c) => !before.has(c)).map((c) => c.slice(c.indexOf(' ') + 1))
      } finally {
        h.kill()
      }
    }
    const bundled = await hosts(true)
    expect(bundled).toContain('openconsole.exe')
    expect(bundled).not.toContain('conhost.exe')
    const system = await hosts(false)
    expect(system).toContain('conhost.exe')
    expect(system).not.toContain('openconsole.exe')
  }, 60_000) // four process lists, each a PowerShell start and a WMI query: seconds apiece on a fresh CI machine

  // like claude.exe, the probe takes its time to quit when its console closes (CTRL_CLOSE_EVENT arrives as SIGHUP); a
  // restart waits 3 s for the old process to exit before it starts the new one
  it.runIf(WIN)('kill() ends the programs of the console at once and reports the exit after them, in either console host', async () => {
    for (const bundledConpty of [true, false]) {
      let out = ''
      let exitedAt = 0
      let child = 0
      let childAliveAtExit = true
      const script = "process.on('SIGHUP',()=>setTimeout(()=>process.exit(),8000));console.log('child '+process.pid);setInterval(()=>{},1000)"
      const h = spawnPty({
        file: 'cmd.exe', args: ['/c', 'node', '-e', script], cwd: process.cwd(), env, cols: 80, rows: 24, bundledConpty,
        onData: (d) => { out += d; answerTerminalQuestion(d, h) },
        onExit: () => {
          exitedAt = Date.now()
          try { process.kill(child, 0) } catch { childAliveAtExit = false }
        }
      })
      try {
        await vi.waitFor(() => expect(out).toMatch(/child \d+/), { timeout: 10_000 })
        child = Number(/child (\d+)/.exec(out)![1])
        const killedAt = Date.now()
        h.kill()
        await vi.waitFor(() => expect(exitedAt).toBeGreaterThan(0), { timeout: 10_000 })
        expect({ bundledConpty, quitWithin3s: exitedAt - killedAt < 3000, childAliveAtExit }).toEqual({ bundledConpty, quitWithin3s: true, childAliveAtExit: false })
      } finally {
        try { process.kill(child) } catch { /* gone */ }
      }
    }
  }, 30_000)

  it.runIf(WIN)('kill() is idempotent and write after kill is ignored', () => {
    const h = spawnPty({ file: 'cmd.exe', args: [], cwd: process.cwd(), env, cols: 80, rows: 24, onData: () => {}, onExit: () => {} })
    h.kill()
    expect(() => h.kill()).not.toThrow()
    expect(() => h.write('dir\r')).not.toThrow()
    expect(() => h.resize(100, 30)).not.toThrow()
  })
})

const node = `'${process.execPath}'`
const probe = (onHup: string): string => `${node} -e "process.on('SIGHUP',()=>{${onHup}});console.log('child '+process.pid);setInterval(()=>{},1000)" & wait`

async function startProbe(onHup: string): Promise<{ kill(): void; child: number; exitedAt(): number }> {
  let out = ''
  let exitedAt = 0
  const h = spawnPty({ file: '/bin/bash', args: ['-c', probe(onHup)], cwd: process.cwd(), env, cols: 80, rows: 24, onData: (d) => { out += d }, onExit: () => { exitedAt = Date.now() } })
  await vi.waitFor(() => expect(out).toMatch(/child \d+/), { timeout: 5000 })
  return { kill: () => h.kill(), child: Number(/child (\d+)/.exec(out)![1]), exitedAt: () => exitedAt }
}

describe.runIf(!WIN)('spawnPty on Linux and macOS', () => {
  it('runs a process and reports output and exit code', async () => {
    let out = ''
    const code = await new Promise<number>((resolve) => {
      spawnPty({ file: '/bin/sh', args: ['-c', 'echo pty-ok'], cwd: process.cwd(), env, cols: 80, rows: 24, onData: (d) => { out += d }, onExit: resolve })
    })
    expect(code).toBe(0)
    await vi.waitFor(() => expect(out).toContain('pty-ok'))
  })

  it('kill() reports the exit once the programs the shell started have quit', async () => {
    const p = await startProbe('setTimeout(()=>process.exit(0),800)')
    const killedAt = Date.now()
    p.kill()
    await vi.waitFor(() => expect(p.exitedAt()).toBeGreaterThan(0), { timeout: 5000 })
    expect(p.exitedAt() - killedAt).toBeGreaterThanOrEqual(700)
    expect(() => process.kill(p.child, 0)).toThrow()
  })

  it('kill() stops waiting after 2 s for a program that ignores SIGHUP, and leaves it running', async () => {
    const p = await startProbe('')
    const killedAt = Date.now()
    p.kill()
    await vi.waitFor(() => expect(p.exitedAt()).toBeGreaterThan(0), { timeout: 5000 })
    expect(p.exitedAt() - killedAt).toBeGreaterThanOrEqual(1900)
    expect(() => process.kill(p.child, 0)).not.toThrow()
    process.kill(p.child, 'SIGKILL')
  })

  // a tab closed while its login shell still runs its profile, as `eval "$(brew shellenv)"`: bash 3.2 (macOS) answers
  // SIGHUP only once such a command ends
  it('kill() ends a shell busy with a command of its startup files at once, not when that command ends', async () => {
    let out = ''
    let exitedAt = 0
    const h = spawnPty({
      file: '/bin/bash', args: ['--norc', '--noprofile', '-i', '-c', 'x=$(echo busy-starting >&2; sleep 10)'], cwd: process.cwd(), env, cols: 80, rows: 24,
      onData: (d) => { out += d }, onExit: () => { exitedAt = Date.now() }
    })
    await vi.waitFor(() => expect(out).toContain('busy-starting'), { timeout: 5000 })
    const killedAt = Date.now()
    h.kill()
    await vi.waitFor(() => expect(exitedAt).toBeGreaterThan(0), { timeout: 8000 })
    expect(exitedAt - killedAt).toBeLessThan(1500)
  })
})
