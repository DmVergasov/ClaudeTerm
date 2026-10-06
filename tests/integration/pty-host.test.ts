import { describe, expect, it, vi } from 'vitest'
import { spawnPty } from '../../src/main/pty-host'
import { WIN } from '../fixtures/platform'

const env = process.env as Record<string, string>

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

describe.runIf(!WIN)('spawnPty on Linux', () => {
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
})
