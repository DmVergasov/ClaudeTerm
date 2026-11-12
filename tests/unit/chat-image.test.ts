import { describe, expect, it } from 'vitest'
import { scaleChatImage, type ChatImageCodec, type ChatPicture } from '../../src/main/chat/chat-image'

const MB = 1024 * 1024

/**
 * a codec that records the calls made on it: the decode, the resize, the bitmap and the two encodes. `alpha` sets the scaled
 * bitmap's alpha: 'opaque' (every byte 255), or 'transparent' (one pixel with alpha 0).
 */
function codec(width: number, height: number, options: { empty?: boolean; pngBytes?: number; jpegBytes?: number; alpha?: 'opaque' | 'transparent' } = {}) {
  const calls: string[] = []
  const picture = (w: number, h: number): ChatPicture => ({
    isEmpty: () => options.empty === true,
    getSize: () => ({ width: w, height: h }),
    resize: (size) => {
      calls.push(`resize ${size.width}x${size.height}`)
      return picture(size.width, size.height)
    },
    toBitmap: () => {
      calls.push('toBitmap')
      const bitmap = Buffer.alloc(w * h * 4, 255)
      if (options.alpha === 'transparent') bitmap[3] = 0
      return bitmap
    },
    toPNG: () => {
      calls.push('toPNG')
      return Buffer.alloc(options.pngBytes ?? 1000)
    },
    toJPEG: (quality) => {
      calls.push(`toJPEG ${quality}`)
      return Buffer.alloc(options.jpegBytes ?? 1000)
    }
  })
  const c: ChatImageCodec = {
    createFromBuffer: () => {
      calls.push('decode')
      return picture(width, height)
    }
  }
  return { c, calls }
}

/**
 * A PNG's signature, IHDR and, when asked, a tRNS chunk: enough for the header the scaler reads. The colour type is the IHDR's
 * (0 grey, 2 RGB, 3 palette, 4 grey with alpha, 6 RGBA).
 */
function pngWith(width: number, height: number, colorType: number, trns = false, whole = true): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8
  ihdr[17] = colorType
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]
  if (trns) {
    const chunk = Buffer.alloc(13)
    chunk.writeUInt32BE(1, 0)
    chunk.write('tRNS', 4, 'latin1')
    parts.push(chunk)
  }
  // the IEND chunk that ends a whole file
  if (whole) parts.push(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]))
  return Buffer.concat(parts)
}

/** a JPEG's start: SOI and an APP0 segment, then padding; the codec is a fake, so the bytes only need the signature */
const jpegBytes = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), Buffer.alloc(40)])
const gifBytes = (): Buffer => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)])
const webpBytes = (): Buffer => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(40)])
const data = jpegBytes()

describe('scaleChatImage', () => {
  it('a JPEG is scaled and encoded as a JPEG: no PNG encode, which costs about half a second for a photo', () => {
    const { c, calls } = codec(4000, 3000)
    const out = scaleChatImage(data, 'image/jpeg', c)
    expect(out.mediaType).toBe('image/jpeg')
    expect(calls).toEqual(['decode', 'resize 1568x1176', 'toJPEG 85'])
  })

  it('a PNG that needs no scaling goes as its own bytes: nothing is decoded or encoded', () => {
    const png = pngWith(800, 600, 6)
    const { c, calls } = codec(800, 600)
    expect(scaleChatImage(png, 'image/png', c)).toEqual({ data: png, mediaType: 'image/png' })
    expect(calls).toEqual([])
  })

  it('a PNG with no alpha in its header (grey, RGB, palette without tRNS) is scaled and encoded as a JPEG, with no bitmap pass', () => {
    for (const colorType of [0, 2, 3]) {
      const { c, calls } = codec(4000, 3000)
      expect(scaleChatImage(pngWith(4000, 3000, colorType), 'image/png', c).mediaType).toBe('image/jpeg')
      expect(calls).toEqual(['decode', 'resize 1568x1176', 'toJPEG 85'])
    }
  })

  it('a palette PNG with tRNS is scaled and checked: fully opaque goes as a JPEG', () => {
    const { c, calls } = codec(4000, 3000, { alpha: 'opaque' })
    expect(scaleChatImage(pngWith(4000, 3000, 3, true), 'image/png', c).mediaType).toBe('image/jpeg')
    expect(calls).toEqual(['decode', 'resize 1568x1176', 'toBitmap', 'toJPEG 85'])
  })

  it('an RGBA PNG that is fully opaque after scaling goes as a JPEG', () => {
    const { c, calls } = codec(4000, 3000, { alpha: 'opaque' })
    expect(scaleChatImage(pngWith(4000, 3000, 6), 'image/png', c).mediaType).toBe('image/jpeg')
    expect(calls).toEqual(['decode', 'resize 1568x1176', 'toBitmap', 'toJPEG 85'])
  })

  it('an RGBA PNG with a transparent pixel keeps its PNG', () => {
    const { c, calls } = codec(4000, 3000, { alpha: 'transparent', pngBytes: 1 * MB })
    expect(scaleChatImage(pngWith(4000, 3000, 6), 'image/png', c).mediaType).toBe('image/png')
    expect(calls).toEqual(['decode', 'resize 1568x1176', 'toBitmap', 'toPNG'])
  })

  it('a PNG whose PNG is over 3.75 MB, with transparency, goes as a JPEG of quality 85', () => {
    const { c, calls } = codec(4000, 3000, { alpha: 'transparent', pngBytes: 4 * MB })
    expect(scaleChatImage(pngWith(4000, 3000, 6), 'image/png', c).mediaType).toBe('image/jpeg')
    expect(calls).toEqual(['decode', 'resize 1568x1176', 'toBitmap', 'toPNG', 'toJPEG 85'])
  })

  it('a PNG within the long edge but over 3.75 MB in bytes is scaled, not sent as it is', () => {
    const big = Buffer.concat([pngWith(800, 600, 2), Buffer.alloc(4 * MB)])
    const { c, calls } = codec(800, 600)
    expect(scaleChatImage(big, 'image/png', c).mediaType).toBe('image/jpeg')
    expect(calls).toContain('decode')
  })

  it('a picture within the long edge is not resized', () => {
    const { c, calls } = codec(1000, 500)
    scaleChatImage(data, 'image/jpeg', c)
    expect(calls).toEqual(['decode', 'toJPEG 85'])
  })

  it('a JPEG still over 3.75 MB when encoded is refused', () => {
    const { c } = codec(4000, 3000, { jpegBytes: 4 * MB })
    expect(() => scaleChatImage(data, 'image/jpeg', c)).toThrow('image too large')
  })

  it('a GIF or a WebP that nativeImage cannot decode goes as it is, when it fits', () => {
    const { c } = codec(0, 0, { empty: true })
    const gif = gifBytes()
    const webp = webpBytes()
    expect(scaleChatImage(gif, 'image/gif', c)).toEqual({ data: gif, mediaType: 'image/gif' })
    expect(scaleChatImage(webp, 'image/webp', c)).toEqual({ data: webp, mediaType: 'image/webp' })
  })

  it('a PNG or a JPEG that does not decode is refused', () => {
    const { c } = codec(0, 0, { empty: true })
    expect(() => scaleChatImage(pngWith(800, 600, 2, false, false), 'image/png', c)).toThrow('cannot decode image/png')
    expect(() => scaleChatImage(data, 'image/jpeg', c)).toThrow('cannot decode image/jpeg')
  })

  it('the format comes from the bytes: a .png holding JPEG bytes is not passed through as a PNG, it goes as image/jpeg', () => {
    const { c, calls } = codec(800, 600)
    const out = scaleChatImage(jpegBytes(), 'image/png', c)
    expect(out.mediaType).toBe('image/jpeg')
    expect(calls).toEqual(['decode', 'toJPEG 85'])
  })

  it('a .png holding GIF bytes that nativeImage cannot decode goes as image/gif', () => {
    const { c } = codec(0, 0, { empty: true })
    const gif = gifBytes()
    expect(scaleChatImage(gif, 'image/png', c)).toEqual({ data: gif, mediaType: 'image/gif' })
  })

  it('a file with no image signature is refused, whatever its extension says', () => {
    const { c, calls } = codec(800, 600)
    expect(() => scaleChatImage(Buffer.from('an image'), 'image/png', c)).toThrow('cannot decode')
    expect(calls).toEqual([])
  })

  it('a PNG cut short (no IEND at the end) is not passed through: it is decoded, and refused when it does not decode', () => {
    const cut = pngWith(800, 600, 6, false, false)
    const { c, calls } = codec(0, 0, { empty: true })
    expect(() => scaleChatImage(cut, 'image/png', c)).toThrow('cannot decode image/png')
    expect(calls).toEqual(['decode'])
  })

  it('a .jpg holding an RGBA PNG with a transparent pixel, scaled, keeps its PNG', () => {
    const { c, calls } = codec(4000, 3000, { alpha: 'transparent', pngBytes: 1 * MB })
    expect(scaleChatImage(pngWith(4000, 3000, 6), 'image/jpeg', c).mediaType).toBe('image/png')
    expect(calls).toEqual(['decode', 'resize 1568x1176', 'toBitmap', 'toPNG'])
  })

  it('a whole small PNG goes as its own bytes, image/png, even when the extension says JPEG', () => {
    const png = pngWith(64, 64, 2)
    const { c, calls } = codec(64, 64)
    expect(scaleChatImage(png, 'image/jpeg', c)).toEqual({ data: png, mediaType: 'image/png' })
    expect(calls).toEqual([])
  })
})
