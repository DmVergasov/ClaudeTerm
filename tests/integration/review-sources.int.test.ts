import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSources, gitInputs, gitTotals, nodeIo } from '../../src/main/review-sources'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-rsrc-'))
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: dir, stdio: 'ignore' }) }
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.ts'), 'one\n')
  writeFileSync(join(dir, 'big.txt'), 'b')
  git('add', '-A')
  git('commit', '-qm', 'one')
  return dir
}

describe('gitInputs', () => {
  it('reads HEAD and the work tree, untracked files and too large ones included', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.ts'), 'two\n')
    writeFileSync(join(dir, 'new.ts'), 'n\n')
    writeFileSync(join(dir, 'big.txt'), 'z'.repeat(1_100_000))
    const r = await gitInputs(nodeIo, dir, 'HEAD', null, [], () => false)
    const view = r.inputs.map((i) => [i.relPath, i.before.kind === 'data' ? i.before.data.toString() : i.before.kind, i.after.kind === 'data' ? i.after.data.toString().slice(0, 5) : i.after.kind])
    expect(view).toEqual([['a.ts', 'one\n', 'two\n'], ['big.txt', 'b', 'too-large'], ['new.ts', 'absent', 'n\n']])
    const forced = await gitInputs(nodeIo, dir, 'HEAD', null, [join(dir, 'big.txt')], () => true)
    expect(forced.inputs[0]!.after.kind).toBe('data')
  })

  it('lists at most 500 files of a view and says there are too many', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'node_modules'))
    for (let i = 0; i < 503; i++) writeFileSync(join(dir, 'node_modules', `m${String(i).padStart(3, '0')}.js`), 'x\n')
    const r = await gitInputs(nodeIo, dir, 'HEAD', null, [], () => false)
    expect(r.tooMany).toBe(true)
    expect(r.inputs).toHaveLength(500)
    expect(r.inputs.every((i) => i.before.kind === 'skipped')).toBe(true)
  })

  it('gitTotals counts the uncommitted changes like the Uncommitted view', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.ts'), 'two\nthree\n')
    writeFileSync(join(dir, 'new.ts'), 'n\nm\n')
    expect(await gitTotals(nodeIo, dir)).toEqual({ files: 2, additions: 4, deletions: 1 })
  })

  it('createSources reports a folder outside git and a bad revision', async () => {
    const s = createSources(nodeIo)
    expect(await s.root(mkdtempSync(join(tmpdir(), 'ct-nogit-')))).toEqual({ root: null, problem: 'Not a git repository' })
    const dir = repo()
    await expect(s.verify(dir, 'nope')).rejects.toThrow('unknown revision: nope')
  })
})
