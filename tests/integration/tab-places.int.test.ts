import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { execGit } from '../../src/main/git-source'
import { pathKey } from '../../src/main/path-key'
import { folderPlace, TabPlaces } from '../../src/main/tab-places'
import type { TabPlace } from '../../src/shared/types'

const git = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const commitAll = (dir: string, msg: string): void => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg) }
const fwd = (p: string): string => p.split('\\').join('/')
const tempParent = (): string => mkdtempSync(join(tmpdir(), 'ct-places-'))

/** a repository on main with one commit, created at `dir` */
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'README.md'), 'shop\n')
  commitAll(dir, 'one')
  return dir
}

describe('tab place from git', () => {
  it('gives the main worktree its project and branch, without a worktree', async () => {
    const parent = tempParent()
    const dir = repo(join(parent, 'shop'))
    const real = realpathSync.native(dir)
    expect(await folderPlace(execGit, dir)).toEqual({
      project: { key: pathKey(real), name: 'shop', parent: basename(dirname(real)) },
      worktree: null,
      branch: 'main'
    })
  })

  it('gives a linked worktree the same project, its own folder and branch', async () => {
    const parent = tempParent()
    const dir = repo(join(parent, 'shop'))
    const linked = join(parent, 'shop-x')
    git(dir, 'worktree', 'add', '-q', '-b', 'feat/x', linked)
    const place = await folderPlace(execGit, linked)
    expect(place).toEqual({
      project: { key: pathKey(realpathSync.native(dir)), name: 'shop', parent: basename(parent) },
      worktree: { path: expect.any(String), color: expect.any(Number) },
      branch: 'feat/x'
    })
    expect(pathKey(place!.worktree!.path)).toBe(pathKey(realpathSync.native(linked)))
    expect(place!.worktree!.color).toBeGreaterThanOrEqual(0)
    expect(place!.worktree!.color).toBeLessThan(6)
  })

  it('gives a linked worktree added through a link to its folder (a junction on Windows) the same place as through the real path', async () => {
    const parent = tempParent()
    const real = join(parent, 'real')
    const dir = repo(join(real, 'shop'))
    const link = join(parent, 'link')
    symlinkSync(real, link, 'junction')
    const linked = join(link, 'shop-x')
    git(join(link, 'shop'), 'worktree', 'add', '-q', '-b', 'feat/x', linked)
    const place = await folderPlace(execGit, linked)
    expect(place).toMatchObject({ project: { key: pathKey(realpathSync.native(dir)), name: 'shop' }, branch: 'feat/x' })
    expect(pathKey(realpathSync.native(place!.worktree!.path))).toBe(pathKey(realpathSync.native(linked)))
    expect(await folderPlace(execGit, join(real, 'shop-x'))).toEqual(place)
    expect((await folderPlace(execGit, join(link, 'shop')))?.worktree).toBeNull()
  })

  it('gives a subfolder of a linked worktree the same place as the worktree', async () => {
    const parent = tempParent()
    const dir = repo(join(parent, 'shop'))
    const linked = join(parent, 'shop-x')
    git(dir, 'worktree', 'add', '-q', '-b', 'feat/x', linked)
    mkdirSync(join(linked, 'src', 'deep'), { recursive: true })
    expect(await folderPlace(execGit, join(linked, 'src', 'deep'))).toEqual(await folderPlace(execGit, linked))
  })

  it('names a detached HEAD by the first 7 characters of its commit', async () => {
    const parent = tempParent()
    const dir = repo(join(parent, 'shop'))
    const head = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-q', '--detach')
    expect((await folderPlace(execGit, dir))?.branch).toBe(head.slice(0, 7))
  })

  it('gives a submodule its own project, not the superproject', async () => {
    const parent = tempParent()
    const lib = repo(join(parent, 'lib-src'))
    const app = repo(join(parent, 'app'))
    git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', lib, 'sub')
    commitAll(app, 'add the submodule')
    const sub = join(app, 'sub')
    expect(await folderPlace(execGit, sub)).toEqual({
      project: { key: pathKey(realpathSync.native(sub)), name: 'sub', parent: 'app' },
      worktree: null,
      branch: 'main'
    })
    expect((await folderPlace(execGit, app))?.project.name).toBe('app')
  })

  it('gives a bare repository with a worktree the name of the repository', async () => {
    const parent = tempParent()
    const bare = join(parent, 'acme.git')
    git(parent, 'init', '-q', '--bare', bare)
    const seed = join(parent, 'seed')
    git(parent, 'clone', '-q', bare, seed)
    git(seed, 'config', 'user.email', 't@example.com')
    git(seed, 'config', 'user.name', 'T')
    git(seed, 'config', 'core.autocrlf', 'false')
    git(seed, 'checkout', '-q', '-b', 'main')
    writeFileSync(join(seed, 'README.md'), 'acme\n')
    commitAll(seed, 'one')
    git(seed, 'push', '-q', 'origin', 'main')
    const folder = join(parent, 'acme-main')
    git(bare, 'worktree', 'add', '-q', folder, 'main')
    const place = await folderPlace(execGit, folder)
    expect(place).toEqual({
      project: { key: pathKey(realpathSync.native(bare)), name: 'acme', parent: basename(realpathSync.native(parent)) },
      worktree: { path: expect.any(String), color: expect.any(Number) },
      branch: 'main'
    })
    expect(pathKey(place!.worktree!.path)).toBe(pathKey(realpathSync.native(folder)))
  })

  it('answers null for a folder outside git and for a folder that does not exist', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ct-nogit-'))
    expect(await folderPlace(execGit, outside)).toBeNull()
    expect(await folderPlace(execGit, join(tempParent(), 'missing'))).toBeNull()
  })

  it('gives the same project key for the repository named with / separators and in upper case', async () => {
    const dir = repo(join(tempParent(), 'shop'))
    const forms = [dir, fwd(dir)]
    if (process.platform === 'win32') forms.push(dir.toUpperCase())
    const keys: (string | undefined)[] = []
    for (const form of forms) keys.push((await folderPlace(execGit, form))?.project.key)
    expect(keys[0]).toBe(pathKey(realpathSync.native(dir)))
    for (const key of keys) expect(key).toBe(keys[0])
  })
})

describe('TabPlaces', () => {
  it('publishes the new branch after a checkout and a refresh of the tab', async () => {
    const dir = repo(join(tempParent(), 'shop'))
    const published: [string, TabPlace | null][] = []
    const places = new TabPlaces({ run: execGit, publish: (id, place) => { published.push([id, place]) } })
    places.addTab('t1', dir)
    await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: 10_000 })
    expect(published[0]![1]!.branch).toBe('main')
    git(dir, 'checkout', '-q', '-b', 'other')
    places.refresh('t1')
    await vi.waitFor(() => expect(published).toHaveLength(2), { timeout: 10_000 })
    expect(published[1]![1]!.branch).toBe('other')
  })
})
