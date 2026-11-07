import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES } from '../../src/shared/image-file'
import { ImageHub } from '../../src/main/image-hub'
import { imageResponse, parseImgUrl, remoteCardSource, resolveImgRequest } from '../../src/main/img-protocol'
import { RemoteImages } from '../../src/main/sync/remote-actions'
import { T1, imageCard } from '../fixtures/host-context'

const EXT = ['png', 'jpg']
let dir: string
let hub: ImageHub
const idOf = (p: string): string => hub.add('t1', p, 'created', null)!.id
const url = (id: string): string => `ctimg://${id}/?v=1`

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ct-imgproto-'))
  hub = new ImageHub({ maxItems: () => 50, onChange: () => {} })
  hub.addTab('t1', dir)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const CARD = '0123456789abcdef0123'
const PNG = Buffer.from('png-bytes')
const emptyHub = new ImageHub({ maxItems: () => 50, onChange: () => {} })

describe('parseImgUrl', () => {
  it('reads the card id and the version', () => {
    expect(parseImgUrl(`ctimg://${CARD}/?v=3`)).toEqual({ id: CARD, version: 3 })
  })

  it('is null for a version that is not a whole number from 1, or a URL with none', () => {
    expect(parseImgUrl('ctimg://x/?v=a')).toBeNull()
    expect(parseImgUrl('ctimg://x/?v=0')).toBeNull()
    expect(parseImgUrl(`ctimg://${CARD}/`)).toBeNull()
  })
})

describe('imageResponse', () => {
  it('a card this device does not have is fetched from its device', async () => {
    expect(await imageResponse(`ctimg://${CARD}/?v=1`, emptyHub, ['png'], async () => ({ data: PNG, type: 'image/png' }))).toEqual({ data: PNG, type: 'image/png' })
  })

  it('an id this device does not have and no device gives answers null', async () => {
    expect(await imageResponse(`ctimg://${CARD}/?v=1`, emptyHub, ['png'])).toBeNull()
  })

  it('a card this device has is served from its file, and never asked of a device', async () => {
    const p = join(dir, 'local-remote.png')
    writeFileSync(p, 'x')
    hub.add('t1', p, 'created', null)
    const id = hub.list('t1').find((c) => c.path === p)!.id
    let asked = 0
    expect(await imageResponse(`ctimg://${id}/?v=1`, hub, EXT, async () => { asked++; return null })).toEqual({ path: p })
    expect(asked).toBe(0)
  })

  it('a card this device has whose file is gone answers null, and is not asked of a device either', async () => {
    const p = join(dir, 'local-gone.png')
    writeFileSync(p, 'x')
    const id = hub.add('t1', p, 'created', null)!.id
    rmSync(p)
    let asked = 0
    expect(await imageResponse(`ctimg://${id}/?v=1`, hub, EXT, async () => { asked++; return null })).toBeNull()
    expect(asked).toBe(0)
  })
})

describe('remoteCardSource (R4)', () => {
  /** a device's card of T1 with id CARD, and what the source asked of the device */
  function known(kind: 'image' | 'video' = 'image', path = '/work/demo/a.png') {
    const images = new RemoteImages()
    images.setCards(T1, [imageCard(1, { id: CARD, path, kind })])
    const asked: [string, string][] = []
    const source = remoteCardSource(images, async (tabId, cardId) => {
      asked.push([tabId, cardId])
      return { version: 1, data: PNG }
    })
    return { images, asked, source }
  }

  it('a card the device knows is fetched from the device of its tab, with its image type', async () => {
    const { asked, source } = known()
    expect(await source(CARD, 1)).toEqual({ data: PNG, type: 'image/png' })
    expect(asked).toEqual([[T1, CARD]])
  })

  it('a card id the device does not know answers null, and no call goes out', async () => {
    const { asked, source } = known()
    expect(await source('deadbeefdeadbeefdead', 1)).toBeNull()
    expect(asked).toEqual([])
  })

  it('another version of a known card answers null, and no call goes out', async () => {
    const { asked, source } = known()
    expect(await source(CARD, 2)).toBeNull()
    expect(asked).toEqual([])
  })

  it('a media card, or a file type the viewer does not show, answers null, and no call goes out', async () => {
    const media = known('video', '/work/demo/clip.mp4')
    expect(await media.source(CARD, 1)).toBeNull()
    const tiff = known('image', '/work/demo/scan.tiff')
    expect(await tiff.source(CARD, 1)).toBeNull()
    expect(media.asked.concat(tiff.asked)).toEqual([])
  })

  it('bytes of another version than the card asked for answer null, and are not kept', async () => {
    const images = new RemoteImages()
    images.setCards(T1, [imageCard(1, { id: CARD, path: '/work/demo/a.png' })])
    const source = remoteCardSource(images, async () => ({ version: 2, data: PNG }))
    expect(await source(CARD, 1)).toBeNull()
    expect(images.cached(CARD, 1)).toBeNull()
  })

  it('a second request of a card is served from the bytes kept, with no second call', async () => {
    const { asked, source } = known()
    await source(CARD, 1)
    expect(await source(CARD, 1)).toEqual({ data: PNG, type: 'image/png' })
    expect(asked).toHaveLength(1)
  })
})

describe('resolveImgRequest', () => {
  it('serves an existing image file', async () => {
    const p = join(dir, 'ok.png')
    writeFileSync(p, 'x')
    expect(await resolveImgRequest(url(idOf(p)), hub, EXT)).toEqual({ path: p })
  })

  it('404 for an unknown id', async () => {
    expect(await resolveImgRequest(url('deadbeef'), hub, EXT)).toBeNull()
  })

  it('404 for a disallowed extension', async () => {
    const p = join(dir, 'a.txt')
    writeFileSync(p, 'x')
    expect(await resolveImgRequest(url(idOf(p)), hub, EXT)).toBeNull()
  })

  it('404 for a deleted file', async () => {
    const p = join(dir, 'gone.png')
    writeFileSync(p, 'x')
    const id = idOf(p)
    rmSync(p)
    expect(await resolveImgRequest(url(id), hub, EXT)).toBeNull()
  })

  it('404 for a directory named *.png', async () => {
    const p = join(dir, 'd.png')
    mkdirSync(p)
    expect(await resolveImgRequest(url(idOf(p)), hub, EXT)).toBeNull()
  })

  it('404 for a media card, even when its extension is allowed', async () => {
    const p = join(dir, 'clip.mp4')
    writeFileSync(p, 'x')
    const id = idOf(p)
    expect(await resolveImgRequest(url(id), hub, ['png'])).toBeNull()
    expect(await resolveImgRequest(url(id), hub, ['png', 'mp4'])).toBeNull()
  })

  it('404 for a file over the size limit', async () => {
    const p = join(dir, 'big.png')
    writeFileSync(p, '')
    truncateSync(p, MAX_IMAGE_BYTES + 1)
    expect(await resolveImgRequest(url(idOf(p)), hub, EXT)).toBeNull()
  })
})
