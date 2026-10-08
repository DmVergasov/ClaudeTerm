import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changedFiles, checkIgnored, EMPTY_TREE, execGit, GitError, headOrEmpty, numstat, readBlobs, repoRoot, revisionInfo, untrackedFiles, verifyRef } from '../../src/main/git-source'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-git-'))
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('config', 'core.autocrlf', 'false')
  return dir
}
const git = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
const commitAll = (dir: string, msg: string): void => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg) }
const rel = (dir: string, changes: { path: string; status: string }[]) =>
  changes.map((c) => [c.path.slice(dir.length + 1).split('\\').join('/'), c.status]).sort()

describe('git source', () => {
  it('finds the root from a subfolder, and null outside a repository', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'src'))
    expect(await repoRoot(execGit, join(dir, 'src'))).toBe(dir)
    const outside = mkdtempSync(join(tmpdir(), 'ct-nogit-'))
    expect(await repoRoot(execGit, outside)).toBeNull()
    expect(await repoRoot(execGit, join(outside, 'missing'))).toBeNull()
  })

  it('gives the root in the form the folder was asked in, as Claude names its files: through a junction too', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'src'))
    const link = join(mkdtempSync(join(tmpdir(), 'ct-link-')), 'project')
    symlinkSync(dir, link, 'junction')
    expect(await repoRoot(execGit, join(link, 'src'))).toBe(link)
    expect(await repoRoot(execGit, realpathSync.native(join(dir, 'src')))).toBe(realpathSync.native(dir))
  })

  it('lists modified, added, untracked and deleted files against HEAD', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.ts'), 'a\n')
    writeFileSync(join(dir, 'gone.ts'), 'g\n')
    commitAll(dir, 'one')
    writeFileSync(join(dir, 'a.ts'), 'A\n')
    rmSync(join(dir, 'gone.ts'))
    writeFileSync(join(dir, 'staged.ts'), 's\n')
    git(dir, 'add', 'staged.ts')
    writeFileSync(join(dir, 'new.ts'), 'n\n')
    expect(rel(dir, await changedFiles(execGit, dir, 'HEAD', null, []))).toEqual([
      ['a.ts', 'modified'], ['gone.ts', 'deleted'], ['new.ts', 'added'], ['staged.ts', 'added']
    ])
  })

  it('compares two revisions and limits to paths, taking them literally', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'x[1].ts'), '1\n')
    writeFileSync(join(dir, 'src', 'x1.ts'), '1\n')
    writeFileSync(join(dir, 'b.ts'), '1\n')
    commitAll(dir, 'one')
    writeFileSync(join(dir, 'src', 'x[1].ts'), '2\n')
    writeFileSync(join(dir, 'src', 'x1.ts'), '2\n')
    writeFileSync(join(dir, 'b.ts'), '2\n')
    commitAll(dir, 'two')
    expect(rel(dir, await changedFiles(execGit, dir, 'HEAD~1', 'HEAD', [join(dir, 'src', 'x[1].ts')]))).toEqual([['src/x[1].ts', 'modified']])
    expect(rel(dir, await changedFiles(execGit, dir, 'HEAD~1', 'HEAD', [join(dir, 'src')]))).toEqual([['src/x1.ts', 'modified'], ['src/x[1].ts', 'modified']])
    await expect(changedFiles(execGit, dir, 'HEAD~1', 'HEAD', [mkdtempSync(join(tmpdir(), 'ct-out-'))])).rejects.toThrow(GitError)
  })

  it('a file with a Cyrillic name keeps its name and content', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'отчёты'))
    const file = join(dir, 'отчёты', 'итоги.md')
    writeFileSync(file, 'было\n')
    commitAll(dir, 'one')
    writeFileSync(file, 'стало\n')
    const changes = await changedFiles(execGit, dir, 'HEAD', null, [])
    expect(changes).toEqual([{ path: file, status: 'modified' }])
    const info = await revisionInfo(execGit, dir, 'HEAD', [file])
    const blob = info.get(file)
    expect(blob?.kind).toBe('blob')
    const blobs = await readBlobs(execGit, dir, [blob?.kind === 'blob' ? blob.id : ''])
    expect([...blobs.values()][0]!.toString('utf8')).toBe('было\n')
  })

  it('reads sizes and blobs in one go; absent files and folders are told apart', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    writeFileSync(join(dir, 'b.txt'), 'world!')
    mkdirSync(join(dir, 'd'))
    writeFileSync(join(dir, 'd', 'x'), 'x')
    commitAll(dir, 'one')
    const info = await revisionInfo(execGit, dir, 'HEAD', [join(dir, 'a.txt'), join(dir, 'b.txt'), join(dir, 'none.txt'), join(dir, 'd')])
    expect([...info.values()].map((i) => (i.kind === 'blob' ? ['blob', i.size] : [i.kind]))).toEqual([['blob', 5], ['blob', 6], ['absent'], ['dir']])
    const ids = [...info.values()].flatMap((i) => (i.kind === 'blob' ? [i.id] : []))
    const blobs = await readBlobs(execGit, dir, ids)
    expect(ids.map((id) => blobs.get(id)!.toString())).toEqual(['hello', 'world!'])
  })

  it('verifies refs, refuses options, and uses the empty tree before the first commit', async () => {
    const dir = repo()
    expect(await headOrEmpty(execGit, dir)).toBe(EMPTY_TREE)
    writeFileSync(join(dir, 'a.ts'), 'a\n')
    expect(await changedFiles(execGit, dir, EMPTY_TREE, null, [])).toEqual([{ path: join(dir, 'a.ts'), status: 'added' }])
    commitAll(dir, 'one')
    expect(await verifyRef(execGit, dir, 'HEAD')).toMatch(/^[0-9a-f]{40}$/)
    await expect(verifyRef(execGit, dir, 'mastr')).rejects.toThrow('unknown revision: mastr')
    await expect(verifyRef(execGit, dir, '--output=x')).rejects.toThrow('unknown revision: --output=x')
  })

  it('numstat counts the lines changed since HEAD, staged ones too; binary files count none', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree\n')
    writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 1, 2]))
    writeFileSync(join(dir, 'gone.ts'), 'g\nh\n')
    commitAll(dir, 'one')
    writeFileSync(join(dir, 'a.ts'), 'one\nTWO\nthree\nfour\n')
    writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 9]))
    rmSync(join(dir, 'gone.ts'))
    writeFileSync(join(dir, 'staged.ts'), 's\n')
    git(dir, 'add', 'staged.ts')
    writeFileSync(join(dir, 'untracked.ts'), 'u\n')
    const counts = (await numstat(execGit, dir, 'HEAD')).map((c) => [c.path.slice(dir.length + 1), c.additions, c.deletions]).sort()
    expect(counts).toEqual([['a.ts', 2, 1], ['b.bin', 0, 0], ['gone.ts', 0, 2], ['staged.ts', 1, 0]])
    expect((await untrackedFiles(execGit, dir, [])).map((p) => p.slice(dir.length + 1))).toEqual(['untracked.ts'])
  })

  it('untrackedFiles lists untracked files in nested folders and not the ignored or tracked ones', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
    mkdirSync(join(dir, 'dist'))
    mkdirSync(join(dir, 'отчёты'))
    writeFileSync(join(dir, '.gitignore'), 'dist/\n*.log\n')
    writeFileSync(join(dir, 'tracked.ts'), 't\n')
    commitAll(dir, 'one')
    writeFileSync(join(dir, 'tracked.ts'), 'T\n')
    writeFileSync(join(dir, 'staged.ts'), 's\n')
    git(dir, 'add', 'staged.ts')
    writeFileSync(join(dir, 'src', 'deep', 'n.ts'), 'n\n')
    writeFileSync(join(dir, 'src', 'with space.ts'), 'n\n')
    writeFileSync(join(dir, 'dist', 'out.js'), 'o\n')
    writeFileSync(join(dir, 'debug.log'), 'l\n')
    writeFileSync(join(dir, 'отчёты', 'итог.txt'), 'x\n')
    const names = async (paths: string[]) => (await untrackedFiles(execGit, dir, paths)).map((p) => p.slice(dir.length + 1).split('\\').join('/')).sort()
    expect(await names([])).toEqual(['src/deep/n.ts', 'src/with space.ts', 'отчёты/итог.txt'])
    expect(await names([join(dir, 'src')])).toEqual(['src/deep/n.ts', 'src/with space.ts'])
    expect(await names([join(dir, 'отчёты')])).toEqual(['отчёты/итог.txt'])
    // the same set git ls-files gives
    const lsFiles = git(dir, '-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard').split('\n').filter((l) => l).sort()
    expect(await names([])).toEqual(lsFiles)
  })

  it('untrackedFiles keeps a name with a leading space and leaves a submodule\'s own files out', async () => {
    const lib = repo()
    writeFileSync(join(lib, 's.ts'), 's\n')
    commitAll(lib, 'lib')
    const dir = repo()
    writeFileSync(join(dir, 'a.ts'), 'a\n')
    commitAll(dir, 'one')
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', lib, 'vendor/lib')
    commitAll(dir, 'with a submodule')
    writeFileSync(join(dir, 'vendor', 'lib', 'untracked.ts'), 'u\n')
    writeFileSync(join(dir, ' lead.ts'), 'l\n')
    const names = (await untrackedFiles(execGit, dir, [])).map((p) => p.slice(dir.length + 1))
    expect(names).toEqual([' lead.ts'])
  })

  it('checkIgnored tells the ignored files, and never a tracked one', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'dist'))
    mkdirSync(join(dir, 'отчёты'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'a\n')
    writeFileSync(join(dir, 'dist', 'kept.js'), 'k\n')
    commitAll(dir, 'one')
    // the rules come after dist/kept.js was committed: a tracked file is not ignored
    writeFileSync(join(dir, '.gitignore'), 'dist/\nотчёты/\n')
    writeFileSync(join(dir, 'dist', 'x.js'), 'x\n')
    writeFileSync(join(dir, 'отчёты', 'итоги.md'), 'i\n')
    const paths = [join(dir, 'dist', 'x.js'), join(dir, 'src', 'a.ts'), join(dir, 'dist', 'kept.js'), join(dir, 'отчёты', 'итоги.md'), join(dir, 'missing', 'm.ts')]
    expect(await checkIgnored(execGit, dir, paths)).toEqual([join(dir, 'dist', 'x.js'), join(dir, 'отчёты', 'итоги.md')])
  })

  it('checkIgnored: nothing ignored (exit 1) is an empty list, no candidates run no git, paths outside the repository are left alone', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.ts'), 'a\n')
    const calls: string[][] = []
    const spy: typeof execGit = (args, cwd, input) => { calls.push(args); return execGit(args, cwd, input) }
    expect(await checkIgnored(spy, dir, [join(dir, 'a.ts')])).toEqual([])
    expect(calls).toHaveLength(1)
    expect(await checkIgnored(spy, dir, [])).toEqual([])
    expect(await checkIgnored(spy, dir, [join(tmpdir(), 'elsewhere', 'x.js')])).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('checkIgnored leaves the files of a submodule alone instead of failing', async () => {
    const lib = repo()
    writeFileSync(join(lib, 's.ts'), 's\n')
    commitAll(lib, 'lib')
    const dir = repo()
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'a.ts'), 'a\n')
    commitAll(dir, 'one')
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', lib, 'vendor/lib')
    writeFileSync(join(dir, '.gitignore'), 'dist/\n')
    writeFileSync(join(dir, 'dist', 'x.js'), 'x\n')
    const paths = [join(dir, 'vendor', 'lib', 's.ts'), join(dir, 'dist', 'x.js'), join(dir, 'a.ts')]
    expect(await checkIgnored(execGit, dir, paths)).toEqual([join(dir, 'dist', 'x.js')])
    expect(await checkIgnored(execGit, dir, [join(dir, 'vendor', 'lib', 's.ts')])).toEqual([])
  })

  it('checkIgnored fails on a git error', async () => {
    const dir = repo()
    const broken: typeof execGit = async () => ({ code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: bad' })
    await expect(checkIgnored(broken, dir, [join(dir, 'a.ts')])).rejects.toThrow(GitError)
  })

  it('does not list a file whose only difference is autocrlf conversion', async () => {
    const dir = repo()
    git(dir, 'config', 'core.autocrlf', 'true')
    writeFileSync(join(dir, 'a.ts'), 'one\r\ntwo\r\n')
    commitAll(dir, 'one')
    expect(await changedFiles(execGit, dir, 'HEAD', null, [])).toEqual([])
  })
})
