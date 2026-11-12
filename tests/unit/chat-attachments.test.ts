import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attachFiles, attachmentOf, AttachedFiles, imageSizeOf, isChatPaths, isChatQuery, mention, prepareMessage, type AttachDeps } from '../../src/main/chat/chat-attachments'
import type { ChatAttachment } from '../../src/shared/chat'

const FOLDER = process.platform === 'win32' ? 'C:\\work\\acme' : '/work/acme'
const OUTSIDE = process.platform === 'win32' ? 'D:\\elsewhere' : '/elsewhere'
const MB = 1024 * 1024

/** a file on the fake disk: its size and its bytes */
interface FakeFile { size: number; data: Buffer }

/** fake disk and scaler: the reads and scales made are recorded */
function fakeDisk(files: Record<string, FakeFile>) {
  const reads: string[] = []
  const scales: string[] = []
  const deps: AttachDeps = {
    stat: async p => (files[p] ? { size: files[p].size, isFile: true } : null),
    read: async p => {
      reads.push(p)
      return files[p].data
    },
    scale: async (data, mediaType) => {
      scales.push(mediaType)
      return { data: Buffer.from('scaled'), mediaType: 'image/png' }
    },
  }
  return { deps, reads, scales }
}

/** an attachment of a file in the folder, as the window sends it */
const att = (path: string, size = 10): ChatAttachment => attachmentOf(path, size)
/** every path was handed out for the tab, with no card */
const allowAll = (path: string): ChatAttachment => attachmentOf(path, 0)
const allowNone = (): undefined => undefined

describe('attachmentOf', () => {
  it('an image type is an image; anything else is a file; no card yet', () => {
    expect(attachmentOf(`${FOLDER}/shot.PNG`, 5)).toEqual({ kind: 'image', path: `${FOLDER}/shot.PNG`, name: 'shot.PNG', size: 5, cardId: null })
    expect(attachmentOf(`${FOLDER}/run.exe`, 5)).toMatchObject({ kind: 'file', name: 'run.exe', cardId: null })
  })
})

describe('mention', () => {
  it('a file inside the folder is its path from the folder, with forward slashes', () => {
    expect(mention(`${FOLDER}/tools/run.exe`, FOLDER)).toBe('@tools/run.exe')
  })

  it('a path with a space is quoted', () => {
    expect(mention(`${FOLDER}/my notes.txt`, FOLDER)).toBe('@"my notes.txt"')
  })

  it('a file outside the folder is its absolute path', () => {
    const outside = join(OUTSIDE, 'notes.txt')
    expect(mention(outside, FOLDER)).toBe(`@${outside}`)
  })
})

describe('prepareMessage', () => {
  it('an image becomes one image block with its media type, after scaling', async () => {
    const path = `${FOLDER}/shot.png`
    const { deps, reads, scales } = fakeDisk({ [path]: { size: 4, data: pngHeader(800, 600) } })
    const out = await prepareMessage({ text: 'look', attachments: [att(path, 4)] }, FOLDER, allowAll, deps)

    expect(out).toMatchObject({ text: 'look', images: [{ mediaType: 'image/png', data: Buffer.from('scaled').toString('base64') }] })
    expect(reads).toEqual([path])
    expect(scales).toEqual(['image/png'])
  })

  it('a GIF or a WebP is an image with its own media type', async () => {
    const gif = `${FOLDER}/a.gif`
    const webp = `${FOLDER}/b.webp`
    const { deps, scales } = fakeDisk({ [gif]: { size: 1, data: gifHeader(16, 16) }, [webp]: { size: 1, data: webpHeader(16, 16) } })
    const out = await prepareMessage({ text: '', attachments: [att(gif, 1), att(webp, 1)] }, FOLDER, allowAll, deps)

    expect(scales).toEqual(['image/gif', 'image/webp'])
    expect('refused' in out).toBe(false)
  })

  it('a file becomes a mention on a line after a blank line; nothing is read', async () => {
    const path = `${FOLDER}/tools/run.exe`
    const { deps, reads } = fakeDisk({ [path]: { size: 10, data: Buffer.from('x') } })
    const out = await prepareMessage({ text: 'run it', attachments: [att(path)] }, FOLDER, allowAll, deps)

    expect(out).toMatchObject({ text: 'run it\n\n@tools/run.exe', images: [] })
    expect(reads).toEqual([])
  })

  it('a message with only files has the mentions as its text, one per line', async () => {
    const a = `${FOLDER}/a.txt`
    const b = `${FOLDER}/my notes.txt`
    const { deps } = fakeDisk({ [a]: { size: 1, data: Buffer.from('a') }, [b]: { size: 1, data: Buffer.from('b') } })
    const out = await prepareMessage({ text: '', attachments: [att(a, 1), att(b, 1)] }, FOLDER, allowAll, deps)

    expect(out).toMatchObject({ text: '@a.txt\n@"my notes.txt"', images: [] })
  })

  it('a file picked by its real path is a short mention when the tab folder is an alias of the folder (junction or symlink)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-alias-'))
    try {
      const real = join(root, 'real')
      const alias = join(root, 'alias')
      mkdirSync(real)
      writeFileSync(join(real, 'notes.txt'), 'x')
      symlinkSync(real, alias, 'junction')
      const path = join(realpathSync.native(real), 'notes.txt')
      const { deps } = fakeDisk({ [path]: { size: 1, data: Buffer.from('x') } })
      const out = await prepareMessage({ text: '', attachments: [att(path, 1)] }, alias, allowAll, deps)

      expect(out).toMatchObject({ text: '@notes.txt' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the attachments are as main knows them: name and size from the disk, the card from the allowed list', async () => {
    const path = `${FOLDER}/shot.png`
    const { deps } = fakeDisk({ [path]: { size: 4, data: Buffer.from('raw!') } })
    const window = { kind: 'image' as const, path, name: 'evil.exe', size: 999, cardId: 'forged' }
    const out = await prepareMessage({ text: '', attachments: [window] }, FOLDER, p => ({ ...attachmentOf(p, 0), cardId: 'card-1' }), deps)

    expect(out).toMatchObject({ attachments: [{ kind: 'image', path, name: 'shot.png', size: 4, cardId: 'card-1' }] })
  })

  it('a file over 30 MB is refused', async () => {
    const path = `${FOLDER}/big.zip`
    const { deps } = fakeDisk({ [path]: { size: 40 * MB, data: Buffer.alloc(0) } })
    expect(await prepareMessage({ text: 'x', attachments: [att(path, 40 * MB)] }, FOLDER, allowAll, deps)).toEqual({ refused: 'big.zip is over 30 MB' })
  })

  it('a path that was never attached is refused, and the reason names the file', async () => {
    const path = `${FOLDER}/run.exe`
    const { deps } = fakeDisk({ [path]: { size: 1, data: Buffer.from('x') } })
    expect(await prepareMessage({ text: 'x', attachments: [att(path, 1)] }, FOLDER, allowNone, deps))
      .toEqual({ refused: 'Cannot attach run.exe: it was not attached in this window' })
  })

  it('a file that is gone is refused', async () => {
    const { deps } = fakeDisk({})
    expect(await prepareMessage({ text: 'x', attachments: [att(`${FOLDER}/gone.txt`, 1)] }, FOLDER, allowAll, deps))
      .toEqual({ refused: 'gone.txt is gone' })
  })

  it('an image that cannot be read is refused with the reason, not thrown', async () => {
    const path = `${FOLDER}/broken.png`
    const { deps } = fakeDisk({ [path]: { size: 1, data: Buffer.from('x') } })
    deps.read = async () => {
      throw new Error('EIO')
    }
    expect(await prepareMessage({ text: 'x', attachments: [att(path, 1)] }, FOLDER, allowAll, deps))
      .toEqual({ refused: 'broken.png could not be read as an image' })
  })

  it('an image the scaler cannot take is refused with the same reason', async () => {
    const path = `${FOLDER}/huge.png`
    const { deps } = fakeDisk({ [path]: { size: 1, data: pngHeader(800, 600) } })
    deps.scale = async () => {
      throw new Error('too large')
    }
    expect(await prepareMessage({ text: 'x', attachments: [att(path, 1)] }, FOLDER, allowAll, deps))
      .toEqual({ refused: 'huge.png could not be read as an image' })
  })

  it('images over 20 MB together are refused; up to 20 MB they are sent', async () => {
    const paths = [`${FOLDER}/a.png`, `${FOLDER}/b.png`, `${FOLDER}/c.png`]
    const { deps } = fakeDisk(Object.fromEntries(paths.map(p => [p, { size: 1, data: pngHeader(800, 600) }])))
    deps.scale = async (_data, mediaType) => ({ data: Buffer.alloc(7 * MB), mediaType })
    const images = paths.map(p => att(p, 1))

    expect(await prepareMessage({ text: '', attachments: images }, FOLDER, allowAll, deps)).toEqual({ refused: 'The images are over 20 MB together' })
    const two = await prepareMessage({ text: '', attachments: images.slice(0, 2) }, FOLDER, allowAll, deps)
    expect('refused' in two).toBe(false)
  })
})

describe('attachFiles', () => {
  /** the Media-panel side and the allowed list, recorded */
  function harnessFiles(files: Record<string, number | null>) {
    const registry = new AttachedFiles()
    const added: [string, string, string, string][] = []
    const deps = {
      stat: async (p: string) => (files[p] == null ? null : { size: files[p] as number, isFile: true }),
      head: async (): Promise<Buffer | null> => pngHeader(800, 600),
      addImage: (tabId: string, path: string, source: string, caption: string) => {
        added.push([tabId, path, source, caption])
        return `card-${added.length}`
      },
      allow: (tabId: string, attached: ChatAttachment[]) => registry.add(tabId, attached),
    }
    return { registry, added, deps }
  }

  it('an image becomes a pasted card and its attachment carries the card id', async () => {
    const path = `${FOLDER}/shot.png`
    const { registry, added, deps } = harnessFiles({ [path]: 42 })
    const out = await attachFiles('tab-a', [path], deps)

    expect(out).toEqual([{ kind: 'image', path, name: 'shot.png', size: 42, cardId: 'card-1' }])
    expect(added).toEqual([['tab-a', path, 'pasted', 'attached by you']])
    expect(registry.get('tab-a', path)).toEqual(out[0])
  })

  it('a file that is not an image has no card', async () => {
    const path = `${FOLDER}/run.exe`
    const { added, deps } = harnessFiles({ [path]: 5 })
    expect(await attachFiles('tab-a', [path], deps)).toEqual([{ kind: 'file', path, name: 'run.exe', size: 5, cardId: null }])
    expect(added).toEqual([])
  })

  it('a path that is not a file is left out: no card, not allowed', async () => {
    const path = `${FOLDER}/gone.png`
    const { registry, added, deps } = harnessFiles({})
    expect(await attachFiles('tab-a', [path], deps)).toEqual([])
    expect(added).toEqual([])
    expect(registry.get('tab-a', path)).toBeUndefined()
  })

  it('the paths are allowed for that tab only', async () => {
    const path = `${FOLDER}/run.exe`
    const { registry, deps } = harnessFiles({ [path]: 5 })
    await attachFiles('tab-a', [path], deps)
    expect(registry.get('tab-a', path)).toBeDefined()
    expect(registry.get('tab-b', path)).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('a path attached in one spelling is allowed in another (case, separator)', async () => {
    const registry = new AttachedFiles()
    registry.add('tab-a', [attachmentOf('C:\\Work\\A.txt', 1)])
    expect(registry.get('tab-a', 'c:/work/a.txt')).toBeDefined()
  })
})

describe('isChatPaths and isChatQuery', () => {
  const abs = (n: number): string => (process.platform === 'win32' ? `C:\\work\\${'a'.repeat(n)}` : `/work/${'a'.repeat(n)}`)

  it('accepts up to 20 absolute paths of at most 4096 characters', () => {
    expect(isChatPaths([abs(10)])).toBe(true)
    expect(isChatPaths(Array.from({ length: 20 }, () => abs(10)))).toBe(true)
    expect(isChatPaths([abs(4096 - 8)])).toBe(true)
  })

  it('refuses 21 paths, a relative path, a path over 4096 characters, a non-array and a non-string', () => {
    expect(isChatPaths(Array.from({ length: 21 }, () => abs(10)))).toBe(false)
    expect(isChatPaths(['relative/x.txt'])).toBe(false)
    expect(isChatPaths([abs(4100)])).toBe(false)
    expect(isChatPaths(abs(10))).toBe(false)
    expect(isChatPaths([42])).toBe(false)
  })

  it('accepts a query of up to 200 characters and refuses a longer one or a non-string', () => {
    expect(isChatQuery('rvts')).toBe(true)
    expect(isChatQuery('q'.repeat(200))).toBe(true)
    expect(isChatQuery('q'.repeat(201))).toBe(false)
    expect(isChatQuery(null)).toBe(false)
  })
})

/** a PNG's first bytes: the signature and its IHDR chunk, with the size the header claims */
function pngHeader(width: number, height: number, type = 'IHDR'): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write(type, 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

/** a JPEG whose frame header (SOF0) claims the size, after an APP0 segment */
function gifHeader(width: number, height: number): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 0xff, width >> 8, height & 0xff, height >> 8])
}

/** a lossy WebP's first chunk: the key frame's start code and size */
function webpHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1')
  b.write('WEBP', 8, 'latin1')
  b.write('VP8 ', 12, 'latin1')
  b[23] = 0x9d
  b[24] = 0x01
  b[25] = 0x2a
  b.writeUInt16LE(width, 26)
  b.writeUInt16LE(height, 28)
  return b
}

function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

describe('imageSizeOf', () => {
  it('reads the size from a PNG header', () => {
    expect(imageSizeOf(pngHeader(640, 480))).toEqual({ width: 640, height: 480 })
  })

  it('reads the size from a JPEG frame header, after the segments before it', () => {
    expect(imageSizeOf(jpegHeader(1200, 800))).toEqual({ width: 1200, height: 800 })
  })

  it('reads the size from a GIF header (little-endian)', () => {
    expect(imageSizeOf(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2c, 0x01, 0x90, 0x01]))).toEqual({ width: 300, height: 400 })
  })

  it('reads the size of a WebP in each of its three formats', () => {
    const riff = (chunk: string, body: Buffer): Buffer => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from(chunk, 'latin1'), Buffer.from([body.length, 0, 0, 0]), body])
    // lossy: the key frame's start code, then the 14-bit size
    const lossy = Buffer.from([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x2c, 0x01, 0xc8, 0x00])
    expect(imageSizeOf(riff('VP8 ', lossy))).toEqual({ width: 300, height: 200 })
    // lossless: the signature byte, then width - 1 and height - 1 in 14 bits each
    const lossless = Buffer.from([0x2f, 0x2b, 0xc1, 0x31, 0x00])
    expect(imageSizeOf(riff('VP8L', lossless))).toEqual({ width: 300, height: 200 })
    // extended: the canvas, as width - 1 and height - 1 in 24 bits each
    const extended = Buffer.from([0x10, 0, 0, 0, 0x2b, 0x01, 0x00, 0xc7, 0x00, 0x00])
    expect(imageSizeOf(riff('VP8X', extended))).toEqual({ width: 300, height: 200 })
  })

  it('a header cut short is no size', () => {
    expect(imageSizeOf(pngHeader(640, 480).subarray(0, 20))).toBeNull()
    expect(imageSizeOf(jpegHeader(1200, 800).subarray(0, 27))).toBeNull()
    expect(imageSizeOf(Buffer.from([0x47, 0x49, 0x46, 0x38]))).toBeNull()
    expect(imageSizeOf(Buffer.alloc(0))).toBeNull()
  })

  it('a header that lies is no size: a zero size, a chunk that is not IHDR, a segment that runs past the end, an unknown format', () => {
    expect(imageSizeOf(pngHeader(0, 480))).toBeNull()
    expect(imageSizeOf(pngHeader(640, 480, 'tEXt'))).toBeNull()
    const runaway = jpegHeader(1200, 800)
    runaway.writeUInt16BE(0xfff0, 4)
    expect(imageSizeOf(runaway)).toBeNull()
    expect(imageSizeOf(Buffer.from('not an image at all, just text'))).toBeNull()
  })
})

describe('an image above the pixel budget', () => {
  it('goes as its path and is not decoded: the message names the file, and no image block is made', async () => {
    const path = `${FOLDER}/huge.png`
    const { deps, scales } = fakeDisk({ [path]: { size: 2 * MB, data: pngHeader(10000, 10000) } })
    const out = await prepareMessage({ text: 'look', attachments: [att(path, 2 * MB)] }, FOLDER, allowAll, deps)
    expect(out).toMatchObject({ text: 'look\n\n@huge.png', images: [] })
    expect(scales).toEqual([])
  })

  it('a picture within the budget is still scaled and sent as an image', async () => {
    const path = `${FOLDER}/small.png`
    const { deps, scales } = fakeDisk({ [path]: { size: 2 * MB, data: pngHeader(1200, 900) } })
    const out = await prepareMessage({ text: '', attachments: [att(path, 2 * MB)] }, FOLDER, allowAll, deps)
    expect(out).toMatchObject({ images: [{ mediaType: 'image/png' }] })
    expect(scales).toEqual(['image/png'])
  })

  it('an attach of a picture above the budget is marked, so its chip says it goes as a path', async () => {
    const path = `${FOLDER}/huge.png`
    const big = fakeDisk({ [path]: { size: 2 * MB, data: pngHeader(10000, 10000) } })
    const attached = await attachFiles('tab', [path], { ...big.deps, addImage: () => null, allow: () => undefined, head: async (p) => big.deps.read(p) })
    expect(attached[0]).toMatchObject({ kind: 'image', oversize: true })
    const small = fakeDisk({ [path]: { size: 2 * MB, data: pngHeader(1200, 900) } })
    const within = await attachFiles('tab', [path], { ...small.deps, addImage: () => null, allow: () => undefined, head: async (p) => small.deps.read(p) })
    expect(within[0]!.oversize).toBeFalsy()
  })
})

describe("an image's budget depends on its format", () => {
  it('a PNG of 25 MP goes as its path: a PNG costs more to scale than a JPEG', async () => {
    const path = `${FOLDER}/wide.png`
    const { deps, scales } = fakeDisk({ [path]: { size: 2 * MB, data: pngHeader(6250, 4000) } })
    const out = await prepareMessage({ text: '', attachments: [att(path, 2 * MB)] }, FOLDER, allowAll, deps)
    expect(out).toMatchObject({ text: '@wide.png', images: [] })
    expect(scales).toEqual([])
  })

  it('a JPEG of 30 MP is still scaled, and re-encoded as a JPEG', async () => {
    const path = `${FOLDER}/photo.jpg`
    const { deps, scales } = fakeDisk({ [path]: { size: 2 * MB, data: jpegHeader(6000, 5000) } })
    const out = await prepareMessage({ text: '', attachments: [att(path, 2 * MB)] }, FOLDER, allowAll, deps)
    expect(out).toMatchObject({ images: [{}] })
    expect(scales).toEqual(['image/jpeg'])
  })

  it('a JPEG of 45 MP goes as its path', async () => {
    const path = `${FOLDER}/huge.jpg`
    const { deps, scales } = fakeDisk({ [path]: { size: 2 * MB, data: jpegHeader(9000, 5000) } })
    const out = await prepareMessage({ text: '', attachments: [att(path, 2 * MB)] }, FOLDER, allowAll, deps)
    expect(out).toMatchObject({ text: '@huge.jpg', images: [] })
    expect(scales).toEqual([])
  })
})

describe('an image whose header cannot be read', () => {
  // a JPEG whose first segment says it runs past the end of the bytes: no size can be read from it
  const broken = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00])

  it('goes as its path: nothing is decoded in main', async () => {
    const path = `${FOLDER}/odd.jpg`
    const { deps, scales } = fakeDisk({ [path]: { size: 2 * MB, data: broken } })
    const out = await prepareMessage({ text: '', attachments: [att(path, 2 * MB)] }, FOLDER, allowAll, deps)
    expect(out).toMatchObject({ text: '@odd.jpg', images: [] })
    expect(scales).toEqual([])
  })

  it('is marked oversize when attached, so its chip says it goes as a path', async () => {
    const path = `${FOLDER}/odd.jpg`
    const { deps } = fakeDisk({ [path]: { size: 2 * MB, data: broken } })
    const attached = await attachFiles('tab', [path], { ...deps, addImage: () => null, allow: () => undefined, head: async (p) => deps.read(p) })
    expect(attached[0]).toMatchObject({ kind: 'image', oversize: true })
  })
})

/** a JPEG with the given segments before its frame header, which has the marker given */
function jpegFrame(width: number, height: number, marker = 0xc0, before: number[][] = []): Buffer {
  const frame = Buffer.from([0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...before.map((s) => Buffer.from(s)), frame])
}

describe('imageSizeOf on the JPEGs with more than one segment before the frame', () => {
  it('skips a Huffman table, whose marker lies in the frame range', () => {
    const dht = [0xff, 0xc4, 0x00, 0x05, 0x00, 0x00, 0x00]
    expect(imageSizeOf(jpegFrame(640, 480, 0xc0, [dht]))).toEqual({ width: 640, height: 480 })
  })

  it('skips fill bytes before a marker', () => {
    expect(imageSizeOf(jpegFrame(640, 480, 0xc0, [[0xff, 0xff]]))).toEqual({ width: 640, height: 480 })
  })

  it('reads a progressive frame (SOF2)', () => {
    expect(imageSizeOf(jpegFrame(640, 480, 0xc2))).toEqual({ width: 640, height: 480 })
  })
})
