import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchImages, type ImageWatcherHandle } from '../../src/main/image-watcher'

const cfg = { extensions: ['png'], ignore: ['node_modules'], maxDepth: 8 }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let handle: ImageWatcherHandle | null = null
afterEach(async () => {
  await handle?.close()
  handle = null
})

function watch(root: string): string[] {
  const events: string[] = []
  handle = watchImages(root, cfg, {
    added: (p) => events.push(`add:${p}`),
    changed: (p) => events.push(`change:${p}`),
    removed: (p) => events.push(`unlink:${p}`),
    error: (e) => events.push(`error:${e.message}`)
  })
  return events
}

/** CPU time this process spends over `ms` while idle: a watcher stuck on a deleted folder burns a whole core */
async function idleCpuMs(ms: number): Promise<number> {
  const c0 = process.cpuUsage()
  await sleep(ms)
  const c = process.cpuUsage(c0)
  return (c.user + c.system) / 1000
}

describe('watchImages', () => {
  it('reports added, changed and removed images and skips ignored ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-watch-'))
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, 'out'))
    const events = watch(root)
    await handle!.ready
    const png = join(root, 'out', 'plot.png')
    writeFileSync(png, 'v1')
    writeFileSync(join(root, 'node_modules', 'x.png'), 'x')
    writeFileSync(join(root, 'notes.txt'), 'x')
    await vi.waitFor(() => expect(events).toContain(`add:${png}`), { timeout: 5000 })
    writeFileSync(png, 'v2-longer')
    await vi.waitFor(() => expect(events).toContain(`change:${png}`), { timeout: 5000 })
    unlinkSync(png)
    await vi.waitFor(() => expect(events).toContain(`unlink:${png}`), { timeout: 5000 })
    expect(events.filter((e) => e.includes('node_modules') || e.includes('notes.txt'))).toEqual([])
  })

  it('reports an image that existed before watching as changed, not added', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-watch-'))
    const png = join(root, 'chart.png')
    writeFileSync(png, 'v1')
    await sleep(50)
    const events = watch(root)
    await handle!.ready
    writeFileSync(png, 'v2-longer')
    await vi.waitFor(() => expect(events).toContain(`change:${png}`), { timeout: 5000 })
    expect(events).not.toContain(`add:${png}`)
  })

  it('reports every image of a burst too big for the OS to report one by one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-watch-'))
    mkdirSync(join(root, 'shots'))
    const events = watch(root)
    await handle!.ready
    for (let i = 0; i < 150; i++) writeFileSync(join(root, 'shots', `s${i}.png`), 'x')
    await vi.waitFor(() => expect(events.filter((e) => e.startsWith('add:'))).toHaveLength(150), { timeout: 8000 })
    expect(new Set(events).size).toBe(150)
  })

  it('keeps reporting, without burning CPU, after a watched subfolder is deleted and created again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-watch-'))
    const out = join(root, 'out')
    mkdirSync(out)
    for (let i = 0; i < 200; i++) writeFileSync(join(out, `old${i}.png`), 'x')
    const events = watch(root)
    await handle!.ready
    rmSync(out, { recursive: true })
    mkdirSync(out)
    for (let i = 0; i < 200; i++) writeFileSync(join(out, `new${i}.png`), 'x')
    await vi.waitFor(() => expect(events).toContain(`add:${join(out, 'new199.png')}`), { timeout: 5000 })
    expect(await idleCpuMs(1000)).toBeLessThan(300)
    const later = join(out, 'later.png')
    writeFileSync(later, 'x')
    await vi.waitFor(() => expect(events).toContain(`add:${later}`), { timeout: 5000 })
  })

  it('reports every image of a deleted folder as removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-watch-'))
    const events = watch(root)
    await handle!.ready
    const out = join(root, 'out')
    mkdirSync(join(out, 'sub'), { recursive: true })
    await sleep(200)
    const pngs = [join(out, 'a.png'), join(out, 'b.png'), join(out, 'c.png'), join(out, 'sub', 'd.png')]
    for (const p of pngs) writeFileSync(p, 'x')
    await vi.waitFor(() => expect(events.filter((e) => e.startsWith('add:'))).toHaveLength(4), { timeout: 5000 })
    rmSync(out, { recursive: true })
    await vi.waitFor(() => expect(events.filter((e) => e.startsWith('unlink:')).sort()).toEqual(pngs.map((p) => `unlink:${p}`).sort()), { timeout: 5000 })
  })

  it('keeps reporting after an empty subfolder is deleted and created again at once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-watch-'))
    const out = join(root, 'out')
    mkdirSync(out)
    const events = watch(root)
    await handle!.ready
    rmSync(out, { recursive: true })
    mkdirSync(out)
    await sleep(500)
    const later = join(out, 'later.png')
    writeFileSync(later, 'x')
    await vi.waitFor(() => expect(events).toContain(`add:${later}`), { timeout: 5000 })
  })

  it('lets go of a watched folder that is deleted, without burning CPU, and watches it again once it is back', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'ct-watch-')), 'proj')
    mkdirSync(root)
    const events = watch(root)
    await handle!.ready
    rmSync(root, { recursive: true })
    await sleep(300)
    // possible only once the watcher has let go: a folder still watched cannot be created again
    mkdirSync(root)
    expect(await idleCpuMs(1000)).toBeLessThan(300)
    const png = join(root, 'back.png')
    await vi.waitFor(() => {
      writeFileSync(png, String(Date.now()))
      expect(events.some((e) => e.endsWith(png))).toBe(true)
    }, { timeout: 8000, interval: 700 })
    expect(events.filter((e) => e.startsWith('error:'))).toEqual([])
  })
})
