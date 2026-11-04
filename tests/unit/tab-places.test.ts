import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GitError, type GitResult, type GitRun } from '../../src/main/git-source'
import { pathKey } from '../../src/main/path-key'
import { folderPlace, parseWorktreeList, TabPlaces, WORKTREE_COLORS, worktreeColors } from '../../src/main/tab-places'
import type { TabPlace } from '../../src/shared/types'

// the existence check of a folder must not be a blocking call: the spy shows whether one is made
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: vi.fn(actual.existsSync) }
})

const SHA_1 = '1111111111111111111111111111111111111111'
const SHA_2 = '2222222222222222222222222222222222222222'
const SHA_3 = '3333333333333333333333333333333333333333'

const ok = (stdout: string): GitResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: '' })
/** git prints paths with forward slashes */
const fwd = (p: string): string => p.split('\\').join('/')

describe('worktree list', () => {
  it('reads the main worktree, a linked one on a branch and a detached one', () => {
    const porcelain = [
      'worktree C:/Work/Acme/shop',
      `HEAD ${SHA_1}`,
      'branch refs/heads/main',
      '',
      'worktree C:/Work/Acme/shop-feat',
      `HEAD ${SHA_2}`,
      'branch refs/heads/feat/x',
      '',
      'worktree C:/Work/Acme/shop-detached',
      `HEAD ${SHA_3}`,
      'detached',
      ''
    ].join('\n')
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: 'C:/Work/Acme/shop', bare: false, branch: 'main', head: SHA_1 },
      { path: 'C:/Work/Acme/shop-feat', bare: false, branch: 'feat/x', head: SHA_2 },
      { path: 'C:/Work/Acme/shop-detached', bare: false, branch: null, head: SHA_3 }
    ])
  })

  it('reads a bare repository, which has no HEAD of its own, and its worktrees', () => {
    const porcelain = [
      'worktree C:/Srv/git/acme.git',
      'bare',
      '',
      'worktree C:/Work/acme-main',
      `HEAD ${SHA_1}`,
      'branch refs/heads/main',
      ''
    ].join('\n')
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: 'C:/Srv/git/acme.git', bare: true, branch: null, head: null },
      { path: 'C:/Work/acme-main', bare: false, branch: 'main', head: SHA_1 }
    ])
  })
})

describe('worktree colors', () => {
  const paths = ['C:/Work/a', 'C:/Work/b', 'C:/Work/c', 'C:/Work/d', 'C:/Work/e', 'C:/Work/f']

  it('gives six paths six different colors', () => {
    const colors = [...worktreeColors(paths).values()]
    expect(WORKTREE_COLORS).toBe(6)
    expect(new Set(colors).size).toBe(6)
    for (const c of colors) expect(c).toBeGreaterThanOrEqual(0)
    for (const c of colors) expect(c).toBeLessThan(6)
  })

  it('gives the same colors whatever the order of the paths', () => {
    expect(worktreeColors([...paths].reverse())).toEqual(worktreeColors(paths))
  })

  it('keeps the color of a path when a path that sorts after it is added', () => {
    const before = worktreeColors(paths.slice(0, 2))
    const after = worktreeColors([...paths.slice(0, 2), 'C:/Work/zeta'])
    for (const [key, color] of before) expect(after.get(key)).toBe(color)
  })
})

describe('folder place from git', () => {
  it('reads the main worktree, its project and its branch', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'ct-place-unit-'))
    const porcelain = `worktree ${fwd(folder)}\nHEAD ${SHA_1}\nbranch refs/heads/main\n\n`
    const run: GitRun = async (args) => (args[0] === 'rev-parse' ? ok(`${fwd(folder)}\n`) : ok(porcelain))
    expect(await folderPlace(run, folder)).toEqual({
      project: { key: pathKey(folder), name: basename(folder), parent: basename(dirname(folder)) },
      worktree: null,
      branch: 'main'
    })
  })

  it('names a project at a drive or file-system root by the path itself', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'ct-place-unit-'))
    const root = process.platform === 'win32' ? 'C:/' : '/'
    const porcelain = `worktree ${root}\nHEAD ${SHA_1}\nbranch refs/heads/main\n\n`
    const run: GitRun = async (args) => (args[0] === 'rev-parse' ? ok(`${root}\n`) : ok(porcelain))
    expect((await folderPlace(run, folder))?.project.name).toBe(root)
  })

  it('answers null when git cannot run', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'ct-place-unit-'))
    const run: GitRun = async () => { throw new GitError('git was not found') }
    expect(await folderPlace(run, folder)).toBeNull()
  })

  it('checks the folder without a blocking existence check, and asks git only for a folder that exists', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'ct-place-unit-'))
    const porcelain = `worktree ${fwd(folder)}\nHEAD ${SHA_1}\nbranch refs/heads/main\n\n`
    const run = vi.fn<GitRun>(async (args) => (args[0] === 'rev-parse' ? ok(`${fwd(folder)}\n`) : ok(porcelain)))
    vi.mocked(existsSync).mockClear()
    expect((await folderPlace(run, folder))?.branch).toBe('main')
    expect(existsSync).not.toHaveBeenCalled()
    const missing = join(folder, 'missing')
    run.mockClear()
    expect(await folderPlace(run, missing)).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
})

/** a git run that counts the asks of each folder (one `rev-parse` per ask) and answers the folder's branch */
function countingGit(branches: Record<string, string>): { run: GitRun; asks: Map<string, number> } {
  const asks = new Map<string, number>()
  const run: GitRun = async (args, cwd) => {
    const folder = cwd
    if (args[0] === 'rev-parse') {
      asks.set(folder, (asks.get(folder) ?? 0) + 1)
      return ok(`${fwd(folder)}\n`)
    }
    return ok(`worktree ${fwd(folder)}\nHEAD ${SHA_1}\nbranch refs/heads/${branches[folder]}\n\n`)
  }
  return { run, asks }
}

describe('TabPlaces', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ct-place-tabs-'))
  const porcelain = `worktree ${fwd(folder)}\nHEAD ${SHA_1}\nbranch refs/heads/main\n\n`
  /** git in the folder, on the branch the getter names at the time of the call */
  const gitOn = (branch: () => string): GitRun => async (args) =>
    args[0] === 'rev-parse' ? ok(`${fwd(folder)}\n`) : ok(porcelain.replace('refs/heads/main', `refs/heads/${branch()}`))

  it('publishes a tab\'s place once, and again only when it changes', async () => {
    let branch = 'main'
    const published: [string, TabPlace | null][] = []
    const places = new TabPlaces({ run: gitOn(() => branch), publish: (id, place) => { published.push([id, place]) } })
    places.addTab('t1', folder)
    await vi.waitFor(() => expect(published).toHaveLength(1))
    places.refresh('t1')
    await new Promise((done) => setTimeout(done, 20))
    expect(published).toHaveLength(1)
    branch = 'other'
    places.refresh('t1')
    await vi.waitFor(() => expect(published).toHaveLength(2))
    expect(published[1]![1]!.branch).toBe('other')
  })

  it('publishes nothing for a tab removed while its place is being asked', async () => {
    const published: string[] = []
    const places = new TabPlaces({ run: gitOn(() => 'main'), publish: (id) => { published.push(id) } })
    places.addTab('t2', folder)
    places.removeTab('t2')
    await new Promise((done) => setTimeout(done, 50))
    expect(published).toEqual([])
  })

  it('publishes null for a tab whose git run fails with an error that is not a GitError', async () => {
    const published: [string, TabPlace | null][] = []
    const run: GitRun = async () => { throw new Error('spawn exploded') }
    const places = new TabPlaces({ run, publish: (id, place) => { published.push([id, place]) } })
    places.addTab('t3', folder)
    await vi.waitFor(() => expect(published).toEqual([['t3', null]]))
  })
})

describe('TabPlaces cache', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'ct-cache-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'ct-cache-b-'))
  const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 20))

  it('publishes a known folder\'s place to a second tab at once, before git answers', async () => {
    const git = countingGit({ [dirA]: 'main' })
    let answering = true
    const run: GitRun = (args, cwd, input) => (answering ? git.run(args, cwd, input) : new Promise<GitResult>(() => {}))
    const published: [string, TabPlace | null][] = []
    const places = new TabPlaces({ run, publish: (id, place) => { published.push([id, place]) } })
    places.addTab('a1', dirA)
    await vi.waitFor(() => expect(published).toHaveLength(1))
    answering = false
    places.addTab('a2', dirA)
    expect(published).toHaveLength(2)
    expect(published[1]![0]).toBe('a2')
    expect(published[1]![1]!.branch).toBe('main')
  })

  it('asks git for each folder once in a refresh of all, and not at all within 10 seconds of the last ask', async () => {
    const git = countingGit({ [dirA]: 'main', [dirB]: 'dev' })
    const published: [string, TabPlace | null][] = []
    const places = new TabPlaces({ run: git.run, publish: (id, place) => { published.push([id, place]) } })
    places.addTab('a1', dirA)
    places.addTab('a2', dirA)
    places.addTab('b1', dirB)
    await vi.waitFor(() => expect(new Set(published.map(([id]) => id)).size).toBe(3))
    await settle()
    git.asks.clear()
    places.refreshAll()
    await settle()
    expect(git.asks.size).toBe(0)

    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10_000)
    try {
      places.refreshAll()
      places.refreshAll()
      await settle()
    } finally {
      clock.mockRestore()
    }
    expect(git.asks.get(dirA)).toBe(1)
    expect(git.asks.get(dirB)).toBe(1)
  })

  it('asks git for the tab\'s folder in every refresh of the tab', async () => {
    const git = countingGit({ [dirA]: 'main' })
    const published: [string, TabPlace | null][] = []
    const places = new TabPlaces({ run: git.run, publish: (id, place) => { published.push([id, place]) } })
    places.addTab('a1', dirA)
    await vi.waitFor(() => expect(published).toHaveLength(1))
    await settle()
    git.asks.clear()
    places.refresh('a1')
    await settle()
    expect(git.asks.get(dirA)).toBe(1)
    places.refresh('a1')
    await vi.waitFor(() => expect(git.asks.get(dirA)).toBe(2))
  })

  it('forgets a folder that no tab uses any more: a tab added to it later waits for git again', async () => {
    const git = countingGit({ [dirA]: 'main' })
    const published: [string, TabPlace | null][] = []
    const places = new TabPlaces({ run: git.run, publish: (id, place) => { published.push([id, place]) } })
    places.addTab('a1', dirA)
    await vi.waitFor(() => expect(published).toHaveLength(1))
    await settle()
    places.removeTab('a1')
    places.addTab('a2', dirA)
    expect(published).toHaveLength(1)
    await vi.waitFor(() => expect(published).toHaveLength(2))
    expect(git.asks.get(dirA)).toBe(2)
  })

  it('keeps a folder that another tab still uses: a tab added to it gets the place at once', async () => {
    const git = countingGit({ [dirA]: 'main' })
    const published: [string, TabPlace | null][] = []
    const places = new TabPlaces({ run: git.run, publish: (id, place) => { published.push([id, place]) } })
    places.addTab('a1', dirA)
    places.addTab('a2', dirA)
    await vi.waitFor(() => expect(published).toHaveLength(2))
    await settle()
    places.removeTab('a1')
    places.addTab('a3', dirA)
    expect(published).toHaveLength(3)
    expect(published[2]![0]).toBe('a3')
  })
})
