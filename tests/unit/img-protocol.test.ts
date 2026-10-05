import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES } from '../../src/shared/image-file'
import { ImageHub } from '../../src/main/image-hub'
import { resolveImgRequest } from '../../src/main/img-protocol'

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

  it('404 for a file over the size limit', async () => {
    const p = join(dir, 'big.png')
    writeFileSync(p, '')
    truncateSync(p, MAX_IMAGE_BYTES + 1)
    expect(await resolveImgRequest(url(idOf(p)), hub, EXT)).toBeNull()
  })
})
