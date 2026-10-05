import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchImages, type ImageWatcherHandle } from '../../src/main/image-watcher'

const cfg = { extensions: ['png'], ignore: ['node_modules'], maxDepth: 8 }
let handle: ImageWatcherHandle | null = null
afterEach(async () => {
  await handle?.close()
  handle = null
})

describe('watchImages', () => {
  it('reports added, changed and removed images and skips ignored ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-watch-'))
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, 'out'))
    const events: string[] = []
    handle = watchImages(root, cfg, {
      added: (p) => events.push(`add:${p}`),
      changed: (p) => events.push(`change:${p}`),
      removed: (p) => events.push(`unlink:${p}`),
      error: (e) => events.push(`error:${e.message}`)
    })
    await handle.ready
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
})
