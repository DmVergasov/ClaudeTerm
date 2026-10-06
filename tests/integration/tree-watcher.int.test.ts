import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TreeWatcher } from '../../src/main/tree-watcher'
import { WIN } from '../fixtures/platform'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let watcher: TreeWatcher | null = null
afterEach(() => {
  watcher?.close()
  watcher = null
})

function watch(root: string, maxDepth = 8): string[] {
  const names: string[] = []
  watcher = new TreeWatcher(root, (_event, name) => names.push(name ?? '<lost>'), { ignore: ['node_modules'], maxDepth })
  watcher.on('error', (e: Error) => names.push(`error:${e.message}`))
  return names
}

describe.runIf(!WIN)('TreeWatcher', () => {
  it('names files relative to the root, in folders made after it started too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-tree-'))
    const names = watch(root)
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    await sleep(100)
    writeFileSync(join(root, 'a', 'b', 'x.png'), 'x')
    await vi.waitFor(() => expect(names).toContain(join('a', 'b', 'x.png')), { timeout: 3000 })
  })

  it('reports the files a folder already holds when it arrives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-tree-'))
    const outside = join(mkdtempSync(join(tmpdir(), 'ct-tree-src-')), 'shots')
    mkdirSync(join(outside, 'deep'), { recursive: true })
    writeFileSync(join(outside, 'deep', 'y.png'), 'y')
    const names = watch(root)
    renameSync(outside, join(root, 'shots'))
    await vi.waitFor(() => expect(names).toContain(join('shots', 'deep', 'y.png')), { timeout: 3000 })
  })

  it('a folder replaced by a new one of the same name is watched again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-tree-'))
    mkdirSync(join(root, 'out'))
    const names = watch(root)
    rmSync(join(root, 'out'), { recursive: true })
    mkdirSync(join(root, 'out'))
    await sleep(300)
    writeFileSync(join(root, 'out', 'later.png'), 'x')
    await vi.waitFor(() => expect(names).toContain(join('out', 'later.png')), { timeout: 3000 })
  })

  it('a folder deleted with files in it reports each of them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-tree-'))
    mkdirSync(join(root, 'out', 'sub'), { recursive: true })
    for (const f of ['a.png', 'b.png', 'c.png']) writeFileSync(join(root, 'out', f), 'x')
    writeFileSync(join(root, 'out', 'sub', 'd.png'), 'x')
    const names = watch(root)
    rmSync(join(root, 'out'), { recursive: true })
    const files = [join('out', 'a.png'), join('out', 'b.png'), join('out', 'c.png'), join('out', 'sub', 'd.png')]
    await vi.waitFor(() => expect(files.filter((f) => names.includes(f))).toEqual(files), { timeout: 3000 })
  })

  it('a folder that turns into a file while its events are on the way is no error, and watching goes on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-tree-'))
    mkdirSync(join(root, 'a'))
    for (let i = 0; i < 20; i++) writeFileSync(join(root, 'a', `x${i}.png`), 'x')
    const names = watch(root)
    rmSync(join(root, 'a'), { recursive: true })
    writeFileSync(join(root, 'a'), 'now a file')
    await sleep(300)
    writeFileSync(join(root, 'later.png'), 'x')
    await vi.waitFor(() => expect(names).toContain('later.png'), { timeout: 3000 })
    expect(names.filter((n) => n.startsWith('error:'))).toEqual([])
  })

  it('names the root itself with an empty name when it is deleted', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'ct-tree-')), 'proj')
    mkdirSync(root)
    const names = watch(root)
    rmSync(root, { recursive: true })
    await vi.waitFor(() => expect(names).toContain(''), { timeout: 3000 })
  })

  it('does not look inside ignored folders or deeper than maxDepth', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-tree-'))
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    const names = watch(root, 1)
    writeFileSync(join(root, 'node_modules', 'x.png'), 'x')
    writeFileSync(join(root, 'a', 'b', 'deep.png'), 'x')
    writeFileSync(join(root, 'a', 'shallow.png'), 'x')
    await vi.waitFor(() => expect(names).toContain(join('a', 'shallow.png')), { timeout: 3000 })
    await sleep(200)
    expect(names.filter((n) => n.endsWith('x.png') || n.endsWith('deep.png'))).toEqual([])
  })
})
