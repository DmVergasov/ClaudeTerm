import { describe, expect, it, vi } from 'vitest'
import { spawnPty } from '../../src/main/pty-host'

const env = process.env as Record<string, string>

describe('spawnPty', () => {
  it('runs a process and reports output and exit code', async () => {
    let out = ''
    const code = await new Promise<number>((resolve) => {
      spawnPty({ file: 'cmd.exe', args: ['/c', 'echo pty-ok'], cwd: process.cwd(), env, cols: 80, rows: 24, onData: (d) => { out += d }, onExit: resolve })
    })
    expect(code).toBe(0)
    await vi.waitFor(() => expect(out).toContain('pty-ok'))
  })

  it('accepts a pre-built command line string', async () => {
    let out = ''
    await new Promise<number>((resolve) => {
      spawnPty({ file: 'cmd.exe', args: '/c echo "quoted arg"', cwd: process.cwd(), env, cols: 80, rows: 24, onData: (d) => { out += d }, onExit: resolve })
    })
    await vi.waitFor(() => expect(out).toContain('"quoted arg"'))
  })

  it('kill() is idempotent and write after kill is ignored', () => {
    const h = spawnPty({ file: 'cmd.exe', args: [], cwd: process.cwd(), env, cols: 80, rows: 24, onData: () => {}, onExit: () => {} })
    h.kill()
    expect(() => h.kill()).not.toThrow()
    expect(() => h.write('dir\r')).not.toThrow()
    expect(() => h.resize(100, 30)).not.toThrow()
  })
})
