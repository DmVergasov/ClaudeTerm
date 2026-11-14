import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileLinks, isRegularFile } from '../../src/main/chat/file-links'

describe('chat file links on disk', () => {
  let root: string
  let folder: string
  let home: string
  let links: FileLinks

  beforeAll(() => {
    // a long name has an 8.3 short name on Windows
    root = mkdtempSync(join(tmpdir(), 'ct-links-long-folder-'))
    folder = join(root, 'work')
    home = join(root, 'home')
    mkdirSync(join(folder, 'src'), { recursive: true })
    mkdirSync(join(folder, 'docs'), { recursive: true })
    mkdirSync(join(folder, 'dir.md'), { recursive: true })
    mkdirSync(join(home, 'notes'), { recursive: true })
    writeFileSync(join(folder, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(folder, 'docs', 'spec.md'), '# Spec\n')
    writeFileSync(join(home, 'notes', 'n.md'), '# Notes\n')
    links = new FileLinks({ isFile: isRegularFile, home })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('relative, absolute and ~ paths that are files are links; a missing file and a folder are not', async () => {
    expect(await links.resolve('t', folder, ['src/a.ts:12', join(folder, 'docs', 'spec.md'), '~/notes/n.md', 'missing/file.md', 'dir.md'])).toEqual([
      { path: 'src/a.ts:12', file: join(folder, 'src', 'a.ts'), kind: 'file', line: 12 },
      { path: join(folder, 'docs', 'spec.md'), file: join(folder, 'docs', 'spec.md'), kind: 'doc', line: null },
      { path: '~/notes/n.md', file: join(home, 'notes', 'n.md'), kind: 'doc', line: null }
    ])
  })

  it('a path through a junction or a symbolic link to a folder is a link', async () => {
    symlinkSync(join(folder, 'src'), join(folder, 'via'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await links.resolve('t', folder, ['via/a.ts'])).map((l) => l.file)).toEqual([join(folder, 'via', 'a.ts')])
  })

  it.runIf(process.platform === 'win32')('on Windows, / and \\ name the same file, case does not matter, and linked compares as pathKey', async () => {
    const r = await links.resolve('t', folder, ['src\\a.ts', 'SRC/A.TS'])
    expect(r.map((l) => l.file)).toEqual([join(folder, 'src', 'a.ts'), join(folder, 'SRC', 'A.TS')])
    expect(links.linked('t', join(folder, 'src', 'a.ts').toUpperCase())).toBe(true)
  })

  it.runIf(process.platform === 'win32')('on Windows, a tab folder named by its 8.3 short name resolves its paths', async () => {
    // a volume without short names gives the long name, and the test still runs; verbatim: cmd reads its quotes as they are
    const short = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${folder}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim()
    const r = await links.resolve('t', short, ['src/a.ts'])
    expect(r.map((l) => l.path)).toEqual(['src/a.ts'])
    expect(links.linked('t', r[0]!.file)).toBe(true)
  })
})
