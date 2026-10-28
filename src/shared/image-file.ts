import { stat } from 'node:fs/promises'
import { extname } from 'node:path'

export const DEFAULT_IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024
export const MEDIA_EXTENSIONS: readonly string[] = ['mp4', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'ogg']

const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'mov', 'webm', 'mkv']

export type ImageCheck = { ok: true; size: number } | { ok: false; error: string }

function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

export function hasImageExtension(path: string, extensions: readonly string[]): boolean {
  const ext = extensionOf(path)
  return ext.length > 0 && extensions.some((e) => e.toLowerCase().replace(/^\./, '') === ext)
}

export function mediaKindOf(path: string): 'audio' | 'video' | null {
  const ext = extensionOf(path)
  if (!MEDIA_EXTENSIONS.includes(ext)) return null
  return VIDEO_EXTENSIONS.includes(ext) ? 'video' : 'audio'
}

export async function checkImageFile(path: string, extensions: readonly string[] = DEFAULT_IMAGE_EXTENSIONS): Promise<ImageCheck> {
  if (!hasImageExtension(path, extensions)) return { ok: false, error: `not a supported image type (${extensions.join(', ')}): ${path}` }
  let st
  try {
    st = await stat(path)
  } catch {
    return { ok: false, error: `file not found: ${path}` }
  }
  if (!st.isFile()) return { ok: false, error: `not a file: ${path}` }
  if (st.size > MAX_IMAGE_BYTES) return { ok: false, error: `image is larger than 50 MB: ${path}` }
  return { ok: true, size: st.size }
}

function unsupportedTypeError(path: string, imageExtensions: readonly string[]): string {
  return `not a supported image, audio or video type (${[...imageExtensions, ...MEDIA_EXTENSIONS].join(', ')}): ${path}`
}

async function checkRegularFile(path: string): Promise<ImageCheck> {
  let st
  try {
    st = await stat(path)
  } catch {
    return { ok: false, error: `file not found: ${path}` }
  }
  if (!st.isFile()) return { ok: false, error: `not a file: ${path}` }
  return { ok: true, size: st.size }
}

// A media file needs only to exist as a regular file; the image size cap does not apply to it.
export async function checkShowableFile(path: string, imageExtensions: readonly string[]): Promise<ImageCheck> {
  if (mediaKindOf(path) === null) {
    if (!hasImageExtension(path, imageExtensions)) return { ok: false, error: unsupportedTypeError(path, imageExtensions) }
    return checkImageFile(path, imageExtensions)
  }
  return checkRegularFile(path)
}

// Re-checks a card before it is opened in the system app: an image or media file that exists as a regular file.
// Unlike checkShowableFile, no size cap applies to images: the cap only protects loading into the renderer.
export async function checkOpenableFile(path: string, imageExtensions: readonly string[]): Promise<ImageCheck> {
  if (mediaKindOf(path) === null && !hasImageExtension(path, imageExtensions)) return { ok: false, error: unsupportedTypeError(path, imageExtensions) }
  return checkRegularFile(path)
}
