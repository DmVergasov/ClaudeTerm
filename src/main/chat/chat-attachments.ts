import { basename, extname, isAbsolute, relative, sep } from 'node:path'
import type { ChatAttachment, ChatSend } from '../../shared/chat'
import type { ImageSource } from '../../shared/types'
import { isWithin, pathKey } from '../path-key'
import { canonicalFolder } from './chat-files'

// The files a chat message carries: images go to Claude as image blocks, other files as @mentions of their paths

/** the media types of the images Claude takes, by extension */
export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

/** a file over this size is refused when the message goes */
const FILE_CAP = 30 * 1024 * 1024
/** the scaled images of one message together: Claude's API refuses a request over this size */
const IMAGES_CAP = 20 * 1024 * 1024
/** what the window may send for attachments and for the @ picker: the guards of the IPC */
const MAX_PATHS = 20
const MAX_PATH_LENGTH = 4096
const MAX_QUERY_LENGTH = 200

export interface AttachDeps {
  stat(p: string): Promise<{ size: number; isFile: boolean } | null>
  read(p: string): Promise<Buffer>
  scale(data: Buffer, mediaType: string): Promise<{ data: Buffer; mediaType: string }>
}

/**
 * The pixels an image may have and still be decoded and scaled in main, by its format (chat-image.ts has the measurements):
 * decode + resize + bitmap check + JPEG encode, on opaque photo-like pictures (chat-image.ts has the table): a PNG of 24 MP takes
 * 181 ms, a JPEG of 40 MP 205 ms. Above its budget an image is not decoded: it goes to Claude as its path, which Claude reads and
 * scales itself. A PNG with real transparency keeps its PNG encode (about 0.5 s), which this budget does not bound.
 */
export const IMAGE_PIXEL_BUDGET = { jpeg: 40_000_000, other: 24_000_000 }

export interface ImageSize { width: number; height: number }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The size an image's header names, read from its first bytes: no decode. PNG (IHDR), GIF, WebP (VP8, VP8L, VP8X) and JPEG (the
 * frame header). Null when the header is cut short, names a zero size, or does not match the chunk or segment it should have.
 */
export function imageSizeOf(b: Buffer): ImageSize | null {
  const sized = (width: number, height: number): ImageSize | null => (width > 0 && height > 0 ? { width, height } : null)
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_SIGNATURE) && b.toString('latin1', 12, 16) === 'IHDR') {
    return sized(b.readUInt32BE(16), b.readUInt32BE(20))
  }
  const gif = b.toString('latin1', 0, 6)
  if (b.length >= 10 && (gif === 'GIF87a' || gif === 'GIF89a')) return sized(b.readUInt16LE(6), b.readUInt16LE(8))
  if (b.length >= 25 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return webpSize(b)
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b)
  return null
}

/** a WebP's size from its first chunk: the lossy key frame, the lossless header, or the extended canvas */
function webpSize(b: Buffer): ImageSize | null {
  const sized = (width: number, height: number): ImageSize | null => (width > 0 && height > 0 ? { width, height } : null)
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return sized(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff)
  }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const [x0, x1, x2, x3] = [b[21]!, b[22]!, b[23]!, b[24]!]
    return sized(1 + (x0 | ((x1 & 0x3f) << 8)), 1 + (((x1 >> 6) & 0x3) | (x2 << 2) | ((x3 & 0xf) << 10)))
  }
  if (chunk === 'VP8X' && b.length >= 30) return sized(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3))
  return null
}

/** a JPEG's size from its frame header, after the segments before it; a segment that runs past the end is no header */
function jpegSize(b: Buffer): ImageSize | null {
  let at = 2
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]!
    // a fill byte, or a marker with no length after it
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    // the end of the image, or the scan: no frame header came before them
    if (marker === 0xd9 || marker === 0xda) return null
    const length = b.readUInt16BE(at + 2)
    if (length < 2 || at + 2 + length > b.length) return null
    // a frame header: SOF0 to SOF15, but not DHT, JPG or DAC, which share the range
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (frame) {
      if (at + 9 > b.length) return null
      const width = b.readUInt16BE(at + 7)
      const height = b.readUInt16BE(at + 5)
      return width > 0 && height > 0 ? { width, height } : null
    }
    at += 2 + length
  }
  return null
}

/**
 * Whether an image goes to Claude as its path rather than being decoded in main: its header names more pixels than its format's
 * budget, or names no size at all (a header that cannot be read is not decoded either).
 */
export const goesAsPath = (head: Buffer): boolean => {
  const size = imageSizeOf(head)
  if (size === null) return true
  const jpeg = head[0] === 0xff && head[1] === 0xd8
  return size.width * size.height > (jpeg ? IMAGE_PIXEL_BUDGET.jpeg : IMAGE_PIXEL_BUDGET.other)
}

/** what attaching paths needs: the disk, the Media panel, and the registry of the tab's allowed files */
export interface AttachFilesDeps {
  stat(p: string): Promise<{ size: number; isFile: boolean } | null>
  /** the first bytes of a file, enough for an image's header; null when it cannot be read */
  head(p: string): Promise<Buffer | null>
  /** the Media-panel card of an image the user attached: its id, or null when the tab has no panel */
  addImage(tabId: string, path: string, source: ImageSource, caption: string): string | null
  /** the files the tab's messages may now carry */
  allow(tabId: string, attached: ChatAttachment[]): void
}

/** the attachment of a file the window was handed: an image when its extension is one Claude takes */
export function attachmentOf(path: string, size: number): ChatAttachment {
  return { kind: mediaTypeOf(path) === null ? 'file' : 'image', path, name: basename(path), size, cardId: null }
}

/** the media type of an image path by its extension, null for any other file: the main process decides, not the window */
function mediaTypeOf(path: string): string | null {
  return IMAGE_TYPES[extname(path).toLowerCase()] ?? null
}

/** a file as Claude reads it in the message: its path from the folder with forward slashes (quoted when it has a space), else its path as given */
export function mention(path: string, folder: string): string {
  const rel = relative(folder, path)
  const text = isWithin(folder, path) && rel !== '' ? rel.split(sep).join('/') : path
  return text.includes(' ') ? `@"${text}"` : `@${text}`
}

/** the files the window was handed, per tab, as main knows them (pathKey): the only files a message of the tab may carry */
export class AttachedFiles {
  private readonly tabs = new Map<string, Map<string, ChatAttachment>>()

  add(tabId: string, attachments: ChatAttachment[]): void {
    let files = this.tabs.get(tabId)
    if (!files) {
      files = new Map()
      this.tabs.set(tabId, files)
    }
    for (const attachment of attachments) files.set(pathKey(attachment.path), { ...attachment })
  }

  get(tabId: string, path: string): ChatAttachment | undefined {
    return this.tabs.get(tabId)?.get(pathKey(path))
  }

  forget(tabId: string): void {
    this.tabs.delete(tabId)
  }
}

/**
 * The text Claude gets (the user's text, then the files' mentions, one per line after a blank line), the image blocks, and
 * the attachments as main knows them; or why the message cannot go. `allowed` gives the attachment the window was handed
 * for the path (its card included), or undefined. Each file is checked, then read: a file is read only here.
 */
export async function prepareMessage(
  s: ChatSend,
  folder: string,
  allowed: (path: string) => ChatAttachment | undefined,
  d: AttachDeps,
): Promise<{ text: string; images: { mediaType: string; data: string }[]; attachments: ChatAttachment[] } | { refused: string }> {
  const images: { mediaType: string; data: string }[] = []
  const attachments: ChatAttachment[] = []
  const mentions: string[] = []
  // the picked files have their real paths: the tab's folder may be an alias (8.3 name, symlink, junction)
  const root = await canonicalFolder(folder)
  let imageBytes = 0
  for (const a of s.attachments) {
    const name = basename(a.path)
    const known = allowed(a.path)
    if (!known) return { refused: `Cannot attach ${name}: it was not attached in this window` }
    const info = await d.stat(a.path)
    if (!info || !info.isFile) return { refused: `${name} is gone` }
    if (info.size > FILE_CAP) return { refused: `${name} is over 30 MB` }
    const mediaType = mediaTypeOf(a.path)
    if (mediaType === null) {
      attachments.push({ ...attachmentOf(a.path, info.size), cardId: known.cardId })
      mentions.push(mention(a.path, root))
      continue
    }
    let data: Buffer
    try {
      data = await d.read(a.path)
    } catch {
      return { refused: `${name} could not be read as an image` }
    }
    // a picture over the budget is not decoded here: Claude gets its path, and reads and scales it itself
    const big = goesAsPath(data)
    attachments.push({ ...attachmentOf(a.path, info.size), cardId: known.cardId, ...(big ? { oversize: true } : {}) })
    if (big) {
      mentions.push(mention(a.path, root))
      continue
    }
    try {
      const scaled = await d.scale(data, mediaType)
      imageBytes += scaled.data.length
      if (imageBytes > IMAGES_CAP) return { refused: 'The images are over 20 MB together' }
      images.push({ mediaType: scaled.mediaType, data: scaled.data.toString('base64') })
    } catch {
      return { refused: `${name} could not be read as an image` }
    }
  }
  const text = [s.text, mentions.join('\n')].filter(part => part !== '').join('\n\n')
  return { text, images, attachments }
}

/**
 * The files the window named, as attachments: a path that is not a file is left out; an image gets a Media-panel card
 * ('pasted'); the rest are allowed for the tab, so that a message may carry them.
 */
export async function attachFiles(tabId: string, paths: string[], d: AttachFilesDeps): Promise<ChatAttachment[]> {
  const attached: ChatAttachment[] = []
  for (const path of paths) {
    const info = await d.stat(path)
    if (!info || !info.isFile) continue
    const attachment = attachmentOf(path, info.size)
    if (attachment.kind === 'image') {
      // a picture too big to decode, or whose header cannot be read, goes as its path: its chip says so
      const head = await d.head(path)
      if (head === null || goesAsPath(head)) attachment.oversize = true
      attachment.cardId = d.addImage(tabId, path, 'pasted', 'attached by you')
    }
    attached.push(attachment)
  }
  d.allow(tabId, attached)
  return attached
}

/** the paths a chat attaches over IPC: at most 20 absolute paths, each of bounded length */
export const isChatPaths = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= MAX_PATHS && v.every(p => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_LENGTH && isAbsolute(p))

/** the @ picker's query over IPC: bounded text */
export const isChatQuery = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_QUERY_LENGTH
