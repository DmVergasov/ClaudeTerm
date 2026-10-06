import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loginShellPath } from '../../src/main/login-env'
import { execRunner, type Runner } from '../../src/main/mcp-registrar'
import { WIN } from '../fixtures/platform'

describe.runIf(!WIN)('loginShellPath with a real bash', () => {
  it('a startup file that prints and waits for input: the PATH it sets still comes back, quickly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ct-home-'))
    writeFileSync(join(home, '.bash_profile'), 'echo "Welcome back"\nread answer\nexport PATH="/opt/ct-test-bin:$PATH"\n')
    const run: Runner = (f, a, o) => execRunner(f, a, { ...o, env: { ...process.env, HOME: home } })
    const started = Date.now()
    const path = await loginShellPath(run, '/bin/bash')
    expect(path?.split(':')[0]).toBe('/opt/ct-test-bin')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('ClaudeTerm started from a terminal as a background job keeps running while it asks the login shell', async () => {
    // the probe stands for ClaudeTerm: it asks the login shell for its PATH and writes down what it got
    const work = mkdtempSync(join(tmpdir(), 'ct-bgjob-'))
    const entry = join(work, 'probe-entry.ts')
    writeFileSync(entry, [
      "import { writeFileSync } from 'node:fs'",
      `import { loginShellPath } from ${JSON.stringify(resolve(__dirname, '../../src/main/login-env'))}`,
      `import { execRunner } from ${JSON.stringify(resolve(__dirname, '../../src/main/mcp-registrar'))}`,
      'writeFileSync(process.argv[3], String(process.pid))',
      "void loginShellPath(execRunner, '/bin/bash').then((p) => { writeFileSync(process.argv[2], String(p)); process.exit(0) })"
    ].join('\n'))
    const probe = join(work, 'probe.js')
    await build({ entryPoints: [entry], outfile: probe, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    const out = join(work, 'path.txt')
    const pidFile = join(work, 'pid.txt')
    writeFileSync(join(work, '.bashrc'), '')
    // an interactive shell on a terminal (script gives it one) runs the probe as a background job
    const job = `'${process.execPath}' '${probe}' '${out}' '${pidFile}' & wait`
    const term = spawn('script', ['-qec', `bash --norc -i -c "${job}"`, '/dev/null'], { env: { ...process.env, HOME: work }, stdio: 'ignore', detached: true })
    try {
      await vi.waitFor(() => expect(existsSync(out)).toBe(true), { timeout: 8000, interval: 200 })
      expect(readFileSync(out, 'utf8')).toContain('/')
    } finally {
      for (const pid of [existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0, -(term.pid ?? 0)]) {
        try {
          if (pid) process.kill(pid, 'SIGKILL')
        } catch {
          // gone already
        }
      }
    }
  }, 15_000)
})
