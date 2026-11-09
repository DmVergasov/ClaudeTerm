import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitInputs, gitTotals, nodeIo } from '../../src/main/review-sources'

// git-lfs keeps large files aside: git holds a pointer (the content's SHA-256 and size), and git-lfs's clean filter runs
// for every modified file git compares with the work tree. In an Unreal project with hundreds of changed assets that
// takes several seconds per git run, and it writes their content into .git/lfs.

// git here reads no system or user configuration: Git for Windows configures git-lfs's own filter system-wide
const saved = { nosystem: process.env.GIT_CONFIG_NOSYSTEM, global: process.env.GIT_CONFIG_GLOBAL }
beforeAll(() => {
  const empty = join(mkdtempSync(join(tmpdir(), 'ct-gitconfig-')), 'gitconfig')
  writeFileSync(empty, '')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_GLOBAL = empty
})
afterAll(() => {
  for (const [key, value] of [['GIT_CONFIG_NOSYSTEM', saved.nosystem], ['GIT_CONFIG_GLOBAL', saved.global]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const git = (dir: string, ...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }

/**
 * A repository that keeps its *.bin files aside as git-lfs does: a stand-in for git-lfs's clean filter gives git a pointer
 * and notes each time it runs.
 */
function lfsRepo(): { dir: string; filterRuns(): number } {
  const dir = mkdtempSync(join(tmpdir(), 'ct-lfs-repo-'))
  const tools = mkdtempSync(join(tmpdir(), 'ct-lfs-filter-'))
  const runs = join(tools, 'runs')
  const clean = join(tools, 'clean.js')
  writeFileSync(clean, [
    "const fs = require('fs')",
    'const d = fs.readFileSync(0)',
    `fs.appendFileSync(${JSON.stringify(runs)}, '.')`,
    "const oid = require('crypto').createHash('sha256').update(d).digest('hex')",
    "process.stdout.write('version https://git-lfs.github.com/spec/v1\\noid sha256:' + oid + '\\nsize ' + d.length + '\\n')"
  ].join('\n'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'config', 'filter.lfs.clean', `node "${clean.split('\\').join('/')}"`)
  git(dir, 'config', 'filter.lfs.required', 'true')
  writeFileSync(join(dir, '.gitattributes'), '*.bin filter=lfs -text\n')
  return { dir, filterRuns: () => (existsSync(runs) ? readFileSync(runs, 'utf8').length : 0) }
}

/** commits `files`, then gives them their second content; `same.bin` gets its own bytes again, with a later time */
function changedLfsRepo(): { dir: string; filterRuns(): number } {
  const r = lfsRepo()
  const put = (name: string, data: Buffer | string): void => writeFileSync(join(r.dir, name), data)
  put('same.bin', Buffer.from([0, 1, 2, 3]))
  put('resized.bin', Buffer.from([0, 5, 6]))
  put('edited.bin', Buffer.from([0, 1, 2, 3]))
  put('a.ts', 'one\n')
  git(r.dir, 'add', '-A')
  git(r.dir, 'commit', '-qm', 'one')
  // git sees its time changed: only the content tells it is the same
  put('same.bin', Buffer.from([0, 1, 2, 3]))
  const later = new Date(Date.now() + 60_000)
  utimesSync(join(r.dir, 'same.bin'), later, later)
  put('resized.bin', Buffer.from([0, 5, 6, 7]))
  // the same size, another content: the SHA-256 tells
  put('edited.bin', Buffer.from([0, 1, 2, 9]))
  put('a.ts', 'one\ntwo\n')
  return r
}

describe('files git-lfs keeps aside', () => {
  it("are compared without git-lfs's filter: the Uncommitted view shows a changed one as binary, and not one whose time alone changed", async () => {
    const { dir, filterRuns } = changedLfsRepo()
    const before = filterRuns()
    const view = await gitInputs(nodeIo, dir, 'HEAD', null, [], () => false)
    expect(view.inputs.map((i) => [i.relPath, i.status, i.before.kind]).sort())
      .toEqual([['a.ts', 'modified', 'data'], ['edited.bin', 'modified', 'binary'], ['resized.bin', 'modified', 'binary']])
    expect(filterRuns()).toBe(before)
  })
  it('count in the status bar as files of no lines; one whose time alone changed does not count', async () => {
    const { dir, filterRuns } = changedLfsRepo()
    const before = filterRuns()
    expect(await gitTotals(nodeIo, dir)).toEqual({ files: 3, additions: 1, deletions: 0 })
    expect(filterRuns()).toBe(before)
  })
})
