import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runsCleanly } from '../../src/main/image-paste'

const node = (code: string): { file: string; args: string[] } => ({ file: process.execPath, args: ['-e', code] })

describe('runsCleanly', () => {
  it('answers true for a command that exits 0', async () => {
    expect(await runsCleanly(node('process.exit(0)'), 10_000)).toBe(true)
  })

  it('answers false for a command that fails, one that cannot start and one that outlasts the time limit', async () => {
    expect(await runsCleanly(node('process.exit(1)'), 10_000)).toBe(false)
    expect(await runsCleanly({ file: join(__dirname, 'no-such-program.exe'), args: [] }, 10_000)).toBe(false)
    expect(await runsCleanly(node('setTimeout(() => {}, 30_000)'), 300)).toBe(false)
  })
})
