import { imageSizeOf } from './chat-attachments'

// The images a chat message carries, scaled for Claude. The codec is Electron's nativeImage in main, and a fake in the tests.

/** the longest edge of an image sent to Claude, and the most its encoded bytes may be */
export const CHAT_IMAGE_EDGE = 1568
export const CHAT_IMAGE_BYTES = Math.floor(3.75 * 1024 * 1024)

/** the parts of a decoded picture the scaler uses: nativeImage has them all */
export interface ChatPicture {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(size: { width: number; height: number }): ChatPicture
  /** the picture's pixels, four bytes each (BGRA on Windows and Linux), rows from the top */
  toBitmap(): Buffer
  toPNG(): Buffer
  toJPEG(quality: number): Buffer
}

export interface ChatImageCodec {
  createFromBuffer(data: Buffer): ChatPicture
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** the last 12 bytes of a whole PNG: an empty IEND chunk */
const PNG_END = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

/** the media type a file's bytes say it is, from its signature: PNG, JPEG, GIF or WebP; null for anything else */
export function sniffImageType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  const head = b.toString('latin1', 0, 6)
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/**
 * Whether a PNG's header allows transparency: an alpha channel (colour type 4 or 6), or a tRNS chunk (a palette's transparent
 * entries, or a key colour), which comes before the picture data. Grey, RGB and palette PNGs without tRNS are opaque.
 */
function pngMayBeTransparent(data: Buffer): boolean {
  const colorType = data[25]
  if (colorType === 4 || colorType === 6) return true
  for (let at = 33; at + 8 <= data.length; ) {
    const type = data.toString('latin1', at + 4, at + 8)
    if (type === 'tRNS') return true
    if (type === 'IDAT' || type === 'IEND') return false
    at += 12 + data.readUInt32BE(at)
  }
  return false
}

/** whether every pixel of a scaled picture is opaque: one pass over its bitmap, which is at most 1568 pixels on its long edge */
function isOpaque(picture: ChatPicture): boolean {
  const bitmap = picture.toBitmap()
  for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i] !== 255) return false
  return true
}

/**
 * An image as Claude takes it, long edge at most 1568 px. The format is the one the bytes' signature says, never the file name's
 * (`claimed`, the extension's type, is not used): a file with no image signature is refused. A whole PNG (signature first, IEND
 * last) that needs no scaling goes as its own bytes: nothing is decoded or
 * encoded. A scaled picture with no transparency goes as a JPEG (quality 85): a JPEG source always, a PNG whose header says it has
 * no alpha, or a PNG whose scaled bitmap is fully opaque. Only a scaled picture with real transparency keeps its PNG, when that
 * fits in 3.75 MB, else it goes as a JPEG. Measured with nativeImage on photo-like pictures (noise over smooth colour fields), in
 * main, median of 3 runs, decode + resize + bitmap check + JPEG encode: 8 MP PNG 70 ms, 12 MP PNG 104 ms, 16 MP PNG 166 ms,
 * 24 MP PNG 181 ms; 12 MP JPEG 80 ms; 40 MP JPEG 205 ms. A scaled PNG with transparency keeps its PNG encode (about 0.5 s).
 * nativeImage cannot decode every format (GIF, WebP): those go as they are when they fit. Throws when no encoding fits.
 */
export function scaleChatImage(data: Buffer, _claimed: string, codec: ChatImageCodec): { data: Buffer; mediaType: string } {
  const mediaType = sniffImageType(data)
  if (mediaType === null) throw new Error('cannot decode: not an image')
  if (mediaType === 'image/png' && data.length <= CHAT_IMAGE_BYTES && data.subarray(data.length - 12).equals(PNG_END)) {
    const size = imageSizeOf(data)
    if (size !== null && Math.max(size.width, size.height) <= CHAT_IMAGE_EDGE) return { data, mediaType }
  }
  const decoded = codec.createFromBuffer(data)
  if (decoded.isEmpty()) {
    // only a GIF or a WebP may go undecoded: a PNG or a JPEG that does not decode is a broken file
    if ((mediaType === 'image/gif' || mediaType === 'image/webp') && data.length <= CHAT_IMAGE_BYTES) return { data, mediaType }
    throw new Error(`cannot decode ${mediaType}`)
  }
  const { width, height } = decoded.getSize()
  const factor = Math.min(1, CHAT_IMAGE_EDGE / Math.max(width, height))
  const image = factor < 1 ? decoded.resize({ width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) }) : decoded
  const opaque = mediaType === 'image/jpeg' || (mediaType === 'image/png' && (!pngMayBeTransparent(data) || isOpaque(image)))
  if (opaque) {
    const jpeg = image.toJPEG(85)
    if (jpeg.length > CHAT_IMAGE_BYTES) throw new Error('image too large')
    return { data: jpeg, mediaType: 'image/jpeg' }
  }
  const png = image.toPNG()
  if (png.length <= CHAT_IMAGE_BYTES) return { data: png, mediaType: 'image/png' }
  const jpeg = image.toJPEG(85)
  if (jpeg.length > CHAT_IMAGE_BYTES) throw new Error('image too large')
  return { data: jpeg, mediaType: 'image/jpeg' }
}
