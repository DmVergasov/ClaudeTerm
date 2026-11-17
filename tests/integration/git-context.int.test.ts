import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitContextOf } from '../../src/main/remote-control/git-context'
import { execGit } from '../../src/main/git-source'

const git = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-gctx-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'first')
  return dir
}

/** a bare origin with branch main pushed and origin/HEAD set, and a checkout of it on branch fix */
function checkoutOfOrigin(): { origin: string; checkout: string } {
  const seed = repo()
  const origin = join(mkdtempSync(join(tmpdir(), 'ct-gctx-origin-')), 'origin.git')
  git(seed, 'init', '-q', '--bare', origin)
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  git(seed, 'fetch', '-q', 'origin')
  git(seed, 'remote', 'set-head', 'origin', 'main')
  git(seed, 'checkout', '-q', '-b', 'fix')
  return { origin, checkout: seed }
}

describe('git context', () => {
  it('a repository: its origin, its branch and its default branch', async () => {
    const { origin, checkout } = checkoutOfOrigin()
    expect(await gitContextOf(checkout, execGit)).toEqual({ gitRepoUrl: origin, branch: 'fix', defaultBranch: 'main' })
  })

  it('credentials in the remote URL never leave: user and password are dropped', async () => {
    const { checkout } = checkoutOfOrigin()
    git(checkout, 'remote', 'set-url', 'origin', 'https://bot:fake-secret-0001@git.example.invalid/acme/app.git')
    expect((await gitContextOf(checkout, execGit))!.gitRepoUrl).toBe('https://git.example.invalid/acme/app.git')
  })

  it('a remote URL that no URL parser reads, or whose scheme is not a web one, loses its credentials too', async () => {
    const { checkout } = checkoutOfOrigin()
    git(checkout, 'remote', 'set-url', 'origin', 'https://bot:fake-secret-0001@git.example.invalid:notaport/acme/app.git')
    expect((await gitContextOf(checkout, execGit))!.gitRepoUrl).toBe('https://git.example.invalid:notaport/acme/app.git')
    git(checkout, 'remote', 'set-url', 'origin', 'git+https://bot:fake-secret-0001@git.example.invalid/acme/app.git')
    expect((await gitContextOf(checkout, execGit))!.gitRepoUrl).toBe('git+https://git.example.invalid/acme/app.git')
  })

  it('an scp-like remote address is kept as git has it', async () => {
    const { checkout } = checkoutOfOrigin()
    git(checkout, 'remote', 'set-url', 'origin', 'git@git.example.invalid:acme/app.git')
    expect((await gitContextOf(checkout, execGit))!.gitRepoUrl).toBe('git@git.example.invalid:acme/app.git')
  })

  it('no default branch known: none is passed', async () => {
    const { origin, checkout } = checkoutOfOrigin()
    git(checkout, 'remote', 'set-head', 'origin', '-d')
    expect(await gitContextOf(checkout, execGit)).toEqual({ gitRepoUrl: origin, branch: 'fix' })
  })

  it('not a repository, or no origin: null', async () => {
    expect(await gitContextOf(mkdtempSync(join(tmpdir(), 'ct-norepo-')), execGit)).toBeNull()
    // a repository made with git init and one commit, without a remote
    expect(await gitContextOf(repo(), execGit)).toBeNull()
  })
})
