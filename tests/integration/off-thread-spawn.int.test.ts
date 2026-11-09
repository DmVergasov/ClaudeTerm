import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RunError, runOffThread } from '../../src/main/off-thread-spawn'
import { pathKey } from '../../src/main/path-key'

const node = process.execPath
const script = (code: string): string[] => ['-e', code]

async function failure(p: Promise<unknown>): Promise<RunError> {
  try {
    await p
  } catch (e) {
    if (e instanceof RunError) return e
    throw e
  }
  throw new Error('the run did not fail')
}

describe('runOffThread', () => {
  it('gives the exit code, stdout as bytes and stderr; stdin carries the input', async () => {
    const r = await runOffThread(node, script(`
      let input = ''
      process.stdin.on('data', (c) => { input += c })
      process.stdin.on('end', () => {
        process.stdout.write(Buffer.from([0xff, 0x00, 0x41]))
        process.stdout.write(input.toUpperCase())
        process.stderr.write('warned')
        process.exit(7)
      })`), { input: 'abc' })
    expect(r.code).toBe(7)
    expect([...r.stdout]).toEqual([0xff, 0x00, 0x41, 0x41, 0x42, 0x43])
    expect(r.stderr).toBe('warned')
  })

  it('runs in the folder it is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-cwd-'))
    const r = await runOffThread(node, script('process.stdout.write(process.cwd())'), { cwd: dir })
    expect(pathKey(realpathSync.native(r.stdout.toString('utf8')))).toBe(pathKey(realpathSync.native(dir)))
  })

  it("a program started without env gets the main process's environment as it is when the program starts", async () => {
    await runOffThread(node, script('0'))
    process.env.CT_OFF_THREAD_PROBE = 'set later'
    try {
      const r = await runOffThread(node, script('process.stdout.write(process.env.CT_OFF_THREAD_PROBE ?? "missing")'))
      expect(r.stdout.toString('utf8')).toBe('set later')
    } finally {
      delete process.env.CT_OFF_THREAD_PROBE
    }
  })

  it('a program given env gets that environment', async () => {
    const r = await runOffThread(node, script('process.stdout.write(process.env.CT_GIVEN ?? "missing")'), { env: { ...process.env, CT_GIVEN: 'given' } })
    expect(r.stdout.toString('utf8')).toBe('given')
  })

  it('a quiet program runs to its exit code with empty output', async () => {
    const r = await runOffThread(node, script('process.stdout.write("hidden"); process.exit(4)'), { quiet: true })
    expect(r).toEqual({ code: 4, stdout: Buffer.alloc(0), stderr: '' })
  })

  it('a missing program fails as not-found', async () => {
    expect((await failure(runOffThread('no-such-program-ct', []))).reason).toBe('not-found')
  })

  it('a program running past its time limit is ended and fails as timeout', async () => {
    const started = Date.now()
    expect((await failure(runOffThread(node, script('setTimeout(() => {}, 60000)'), { timeoutMs: 500 }))).reason).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('a program writing more than maxOutput is ended and fails as too-large', async () => {
    const e = await failure(runOffThread(node, script('process.stdout.write("x".repeat(100000)); setTimeout(() => {}, 60000)'), { maxOutput: 1000, timeoutMs: 20_000 }))
    expect(e.reason).toBe('too-large')
  })

  it('runs programs side by side: a slow one does not hold back a quick one', async () => {
    const ended: string[] = []
    const slow = runOffThread(node, script('setTimeout(() => process.stdout.write("slow"), 1500)')).then((r) => ended.push(r.stdout.toString('utf8')))
    await runOffThread(node, script('process.stdout.write("quick")')).then((r) => ended.push(r.stdout.toString('utf8')))
    await slow
    expect(ended).toEqual(['quick', 'slow'])
  })
})
