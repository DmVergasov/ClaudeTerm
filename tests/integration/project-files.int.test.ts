import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { matchFiles, projectFiles } from '../../src/main/chat/project-files'
import { execGit, type GitRun } from '../../src/main/git-source'

const dir = (): string => mkdtempSync(join(tmpdir(), 'ct-project-files-'))

/** writes a file, its folders made first */
function write(root: string, rel: string, text = 'x'): void {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('projectFiles in a git repository', () => {
  it('lists the tracked and the untracked files that are not ignored, and leaves out the ignored ones', async () => {
    const root = dir()
    execFileSync('git', ['init', '-q'], { cwd: root })
    write(root, 'src/tracked.ts')
    execFileSync('git', ['add', 'src/tracked.ts'], { cwd: root })
    write(root, 'untracked.md')
    write(root, '.gitignore', 'dist/\n')
    write(root, 'dist/out.js')

    const files = await projectFiles(root, execGit)

    expect(files).toEqual(expect.arrayContaining(['src/tracked.ts', 'untracked.md', '.gitignore']))
    expect(files.some(f => f.startsWith('dist/'))).toBe(false)
    expect(files.every(f => !f.includes('\\'))).toBe(true)
  })

  it('lists the files of a subfolder of the repository from that subfolder', async () => {
    const root = dir()
    execFileSync('git', ['init', '-q'], { cwd: root })
    write(root, 'app/inside.ts')
    write(root, 'outside.ts')

    const files = await projectFiles(join(root, 'app'), execGit)

    expect(files).toEqual(['inside.ts'])
  })
})

describe('projectFiles outside git', () => {
  it('walks the folder and skips node_modules and .git', async () => {
    const root = dir()
    write(root, 'src/a.ts')
    write(root, 'node_modules/pkg/index.js')
    write(root, '.git/config')

    const files = await projectFiles(root, execGit)

    expect(files).toEqual(['src/a.ts'])
  })

  it('goes down six folders at most', async () => {
    const root = dir()
    write(root, 'l1/l2/l3/l4/l5/l6/in.txt')
    write(root, 'l1/l2/l3/l4/l5/l6/l7/out.txt')

    const files = await projectFiles(root, execGit)

    expect(files).toContain('l1/l2/l3/l4/l5/l6/in.txt')
    expect(files.some(f => f.endsWith('out.txt'))).toBe(false)
  })

  it('keeps the list for 30 seconds, then reads the folder again', async () => {
    const root = dir()
    write(root, 'first.txt')
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    expect(await projectFiles(root, execGit)).toEqual(['first.txt'])

    write(root, 'second.txt')
    now.mockReturnValue(1_000_000 + 29_000)
    expect(await projectFiles(root, execGit)).toEqual(['first.txt'])

    now.mockReturnValue(1_000_000 + 31_000)
    expect((await projectFiles(root, execGit)).sort()).toEqual(['first.txt', 'second.txt'])
  })
})

describe('projectFiles with a fake git', () => {
  it('two calls at once on one folder share one listing', async () => {
    let calls = 0
    const run: GitRun = async () => {
      calls++
      return { code: 0, stdout: Buffer.from('a.ts\0b.ts\0'), stderr: '' }
    }
    const [one, two] = await Promise.all([projectFiles('/fake/shared', run), projectFiles('/fake/shared', run)])

    expect(calls).toBe(1)
    expect(one).toEqual(['a.ts', 'b.ts'])
    expect(two).toEqual(['a.ts', 'b.ts'])
  })

  it('a repository with more than 20 000 paths is cut at 20 000', async () => {
    const run: GitRun = async () => ({ code: 0, stdout: Buffer.from(Array.from({ length: 25_000 }, (_, i) => `f${i}.ts`).join('\0')), stderr: '' })

    expect(await projectFiles('/fake/big', run)).toHaveLength(20_000)
  })
})

describe('matchFiles', () => {
  it('puts the file whose name matches first, then the shorter path', () => {
    expect(matchFiles(['src/revenue.ts', 'docs/rv.md'], 'rvts')[0]).toBe('src/revenue.ts')
  })

  it('a name hit comes before a path hit, however long the path', () => {
    expect(matchFiles(['app/x/b.ts', 'src/application.ts'], 'app')).toEqual(['src/application.ts', 'app/x/b.ts'])
  })

  it('matches the letters in order, ignoring case, and leaves out the rest', () => {
    expect(matchFiles(['Src/Main.ts', 'readme.md'], 'SMT')).toEqual(['Src/Main.ts'])
  })

  it('returns at most the limit, 50 by default', () => {
    const files = Array.from({ length: 80 }, (_, i) => `f${i}.ts`)
    expect(matchFiles(files, 'f')).toHaveLength(50)
    expect(matchFiles(files, 'f', 3)).toHaveLength(3)
  })
})
