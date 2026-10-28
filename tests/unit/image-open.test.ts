import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageHub } from '../../src/main/image-hub'
import { openCard } from '../../src/main/image-open'
import { DEFAULT_IMAGE_EXTENSIONS, MAX_IMAGE_BYTES } from '../../src/shared/image-file'
import type { ImageCard } from '../../src/shared/types'

let dir: string
let hub: ImageHub
const EXT = [...DEFAULT_IMAGE_EXTENSIONS]

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ct-imgopen-'))
  hub = new ImageHub({ maxItems: () => 50, onChange: () => {} })
  hub.addTab('t1', dir)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function cardFor(name: string, make: (p: string) => void): ImageCard {
  const p = join(dir, name)
  make(p)
  return hub.add('t1', p, 'created', null)!
}

describe('openCard', () => {
  let openPath: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>
  let toast: ReturnType<typeof vi.fn<(message: string) => void>>
  beforeEach(() => {
    openPath = vi.fn(async () => '')
    toast = vi.fn()
  })
  const deps = () => ({ imageExtensions: EXT, openPath, toast })

  it('opens an existing media card once with its path and no toast', async () => {
    const card = cardFor('clip.mp4', (p) => writeFileSync(p, 'x'))
    expect(card.kind).toBe('video')
    await openCard(card, deps())
    expect(openPath).toHaveBeenCalledTimes(1)
    expect(openPath).toHaveBeenCalledWith(card.path)
    expect(toast).not.toHaveBeenCalled()
  })

  it('does not open a media card whose file was deleted, and toasts file not found', async () => {
    const card = cardFor('gone.mp3', (p) => writeFileSync(p, 'x'))
    rmSync(card.path)
    await openCard(card, deps())
    expect(openPath).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toContain('file not found')
  })

  it('does not open a media card replaced by a directory, and toasts', async () => {
    const card = cardFor('swapped.wav', (p) => writeFileSync(p, 'x'))
    rmSync(card.path)
    mkdirSync(card.path)
    await openCard(card, deps())
    expect(openPath).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('toasts the error text that openPath resolves with', async () => {
    openPath.mockResolvedValueOnce('No application is associated')
    const card = cardFor('song.ogg', (p) => writeFileSync(p, 'x'))
    await openCard(card, deps())
    expect(openPath).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('No application is associated')
  })

  it('opens an image card too', async () => {
    const card = cardFor('pic.png', (p) => writeFileSync(p, 'x'))
    expect(card.kind).toBe('image')
    await openCard(card, deps())
    expect(openPath).toHaveBeenCalledWith(card.path)
    expect(toast).not.toHaveBeenCalled()
  })

  it('opens an image larger than the 50 MB cap, which only protects loading into the renderer', async () => {
    const card = cardFor('huge.png', (p) => {
      const fd = openSync(p, 'w')
      ftruncateSync(fd, MAX_IMAGE_BYTES + 1)
      closeSync(fd)
    })
    await openCard(card, deps())
    expect(openPath).toHaveBeenCalledWith(card.path)
    expect(toast).not.toHaveBeenCalled()
  })

  it('refuses a card whose extension is no longer in the allowed list, with a toast', async () => {
    const card = cardFor('old.png', (p) => writeFileSync(p, 'x'))
    await openCard(card, { ...deps(), imageExtensions: ['jpg'] })
    expect(openPath).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toContain('not a supported image, audio or video type')
  })
})
