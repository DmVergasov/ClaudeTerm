import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkImageFile, hasImageExtension, MAX_IMAGE_BYTES } from '../../src/shared/image-file'

const dir = mkdtempSync(join(tmpdir(), 'ct-img-'))

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
