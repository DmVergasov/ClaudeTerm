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

  it('leaves out the files the exclusion names: listed, never read, and not counted against the limit', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'tests'))
    for (let i = 0; i < 503; i++) writeFileSync(join(dir, 'tests', `t${String(i).padStart(3, '0')}.ts`), 'x\n')
    writeFileSync(join(dir, 'a.ts'), 'two\n')
    const read: string[] = []
    const io = { ...nodeIo, readDisk: (p: string) => { read.push(p); return nodeIo.readDisk(p) } }
    const r = await gitInputs(io, dir, 'HEAD', null, [], () => false, (rel) => rel.startsWith('tests/'))
    expect(r.tooMany).toBe(false)
    expect(r.inputs.map((i) => i.relPath)).toEqual(['a.ts'])
    expect(r.excluded).toHaveLength(503)
    expect(r.excluded![0]).toBe(join(dir, 'tests', 't000.ts'))
    expect(read).toEqual([join(dir, 'a.ts')])
  })

  it('asks the exclusion once per file, with the path inside the repository (/ separators), whatever folders hold the repository', async () => {
    // the repository itself lives in a folder named "tests"
    const dir = join(mkdtempSync(join(tmpdir(), 'ct-rsrc-')), 'tests', 'app')
    mkdirSync(dir, { recursive: true })
    const git = (...a: string[]): void => { execFileSync('git', a, { cwd: dir, stdio: 'ignore' }) }
    git('init', '-q')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 'T')
    writeFileSync(join(dir, 'a.ts'), 'one\n')
    git('add', '-A')
    git('commit', '-qm', 'one')
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
    writeFileSync(join(dir, 'a.ts'), 'two\n')
    writeFileSync(join(dir, 'src', 'deep', 'b.ts'), 'b\n')
    const asked: string[] = []
    const r = await gitInputs(nodeIo, dir, 'HEAD', null, [], () => false, (rel) => { asked.push(rel); return false })
    expect(asked.sort()).toEqual(['a.ts', 'src/deep/b.ts'])
    expect(r.inputs).toHaveLength(2)
  })

  it('leaves them out of a commit range as well', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'tests'))
    writeFileSync(join(dir, 'tests', 'a.test.ts'), 'x\n')
    writeFileSync(join(dir, 'b.ts'), 'y\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'two'], { cwd: dir })
    const r = await gitInputs(nodeIo, dir, 'HEAD~1', 'HEAD', [], () => false, (rel) => rel.startsWith('tests/'))
    expect(r.inputs.map((i) => i.relPath)).toEqual(['b.ts'])
    expect(r.excluded).toEqual([join(dir, 'tests', 'a.test.ts')])
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
