import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkImageFile, checkOpenableFile, checkShowableFile, hasImageExtension, MAX_IMAGE_BYTES, mediaKindOf } from '../../src/shared/image-file'

const dir = mkdtempSync(join(tmpdir(), 'ct-img-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('hasImageExtension', () => {
  it('is case-insensitive and needs an extension', () => {
    expect(hasImageExtension('C:\\a\\Shot.PNG', ['png'])).toBe(true)
    expect(hasImageExtension('C:\\a\\notes.txt', ['png'])).toBe(false)
    expect(hasImageExtension('C:\\a\\png', ['png'])).toBe(false)
  })
})

describe('checkImageFile', () => {
  it('accepts an existing image', async () => {
    const p = join(dir, 'ok.png')
    writeFileSync(p, Buffer.from([1, 2, 3]))
    expect(await checkImageFile(p)).toEqual({ ok: true, size: 3 })
  })

  it('rejects missing files, wrong types, directories and huge files', async () => {
    expect((await checkImageFile(join(dir, 'missing.png'))).ok).toBe(false)
    const txt = join(dir, 'a.txt')
    writeFileSync(txt, 'x')
    expect((await checkImageFile(txt)).ok).toBe(false)
    const folder = join(dir, 'folder.png')
    mkdirSync(folder)
    expect((await checkImageFile(folder)).ok).toBe(false)
    const big = join(dir, 'big.png')
    const fd = openSync(big, 'w')
    ftruncateSync(fd, MAX_IMAGE_BYTES + 1)
    closeSync(fd)
    const r = await checkImageFile(big)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('50 MB')
  })
})

describe('mediaKindOf', () => {
  it.each(['mp4', 'mov', 'webm', 'mkv'])('names %s as video', (ext) => {
    expect(mediaKindOf(`C:\\a\\Clip.${ext.toUpperCase()}`)).toBe('video')
  })

  it.each(['mp3', 'wav', 'm4a', 'ogg'])('names %s as audio', (ext) => {
    expect(mediaKindOf(`/a/song.${ext}`)).toBe('audio')
  })

  it('names nothing else', () => {
    expect(mediaKindOf('/a/shot.png')).toBeNull()
    expect(mediaKindOf('/a/mp4')).toBeNull()
  })
})

describe('checkShowableFile', () => {
  it('accepts a media file larger than the image cap', async () => {
    const p = join(dir, 'long.mp4')
    const fd = openSync(p, 'w')
    ftruncateSync(fd, MAX_IMAGE_BYTES + 1)
    closeSync(fd)
    expect(await checkShowableFile(p, ['png'])).toEqual({ ok: true, size: MAX_IMAGE_BYTES + 1 })
  })

  it('refuses a missing media file', async () => {
    const p = join(dir, 'gone.wav')
    expect(await checkShowableFile(p, ['png'])).toEqual({ ok: false, error: `file not found: ${p}` })
  })

  it('refuses a directory named like a media file', async () => {
    const p = join(dir, 'x.mp4')
    mkdirSync(p)
    expect(await checkShowableFile(p, ['png'])).toEqual({ ok: false, error: `not a file: ${p}` })
  })

  it('refuses other non-image types and names the media types too', async () => {
    const p = join(dir, 'notes.txt')
    writeFileSync(p, 'x')
    const r = await checkShowableFile(p, ['png'])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('not a supported image, audio or video type (png, mp4, mov, webm, mkv, mp3, wav, m4a, ogg)')
  })

  it('refuses a flac or avi file, which show_image does not take', async () => {
    const p = join(dir, 'track.flac')
    writeFileSync(p, 'x')
    expect((await checkShowableFile(p, ['png'])).ok).toBe(false)
  })

  it('still refuses an image over the cap, so show_image keeps the size limit', async () => {
    const p = join(dir, 'capped.png')
    const fd = openSync(p, 'w')
    ftruncateSync(fd, MAX_IMAGE_BYTES + 1)
    closeSync(fd)
    const r = await checkShowableFile(p, ['png'])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('50 MB')
  })

  it('checks an image exactly as checkImageFile does', async () => {
    const p = join(dir, 'same.png')
    writeFileSync(p, Buffer.from([1, 2, 3]))
    expect(await checkShowableFile(p, ['png'])).toEqual(await checkImageFile(p, ['png']))
    const missing = join(dir, 'missing2.png')
    expect(await checkShowableFile(missing, ['png'])).toEqual(await checkImageFile(missing, ['png']))
  })
})

describe('checkOpenableFile', () => {
  it('accepts an image over the cap, since opening it loads nothing into the renderer', async () => {
    const p = join(dir, 'open-huge.png')
    const fd = openSync(p, 'w')
    ftruncateSync(fd, MAX_IMAGE_BYTES + 1)
    closeSync(fd)
    expect(await checkOpenableFile(p, ['png'])).toEqual({ ok: true, size: MAX_IMAGE_BYTES + 1 })
  })

  it('accepts a media file of any size', async () => {
    const p = join(dir, 'open-long.mp3')
    writeFileSync(p, Buffer.from([1, 2, 3]))
    expect(await checkOpenableFile(p, ['png'])).toEqual({ ok: true, size: 3 })
  })

  it('refuses an image whose extension is no longer allowed', async () => {
    const p = join(dir, 'open-old.png')
    writeFileSync(p, 'x')
    const r = await checkOpenableFile(p, ['jpg'])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('not a supported image, audio or video type')
  })

  it('refuses a missing file, a directory and an unsupported type', async () => {
    expect(await checkOpenableFile(join(dir, 'open-missing.png'), ['png'])).toEqual({ ok: false, error: `file not found: ${join(dir, 'open-missing.png')}` })
    const folder = join(dir, 'open-folder.png')
    mkdirSync(folder)
    expect(await checkOpenableFile(folder, ['png'])).toEqual({ ok: false, error: `not a file: ${folder}` })
    const txt = join(dir, 'open-notes.txt')
    writeFileSync(txt, 'x')
    expect((await checkOpenableFile(txt, ['png'])).ok).toBe(false)
  })
})
