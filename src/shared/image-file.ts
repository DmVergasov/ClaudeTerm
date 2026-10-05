import { stat } from 'node:fs/promises'
import { extname } from 'node:path'

export const DEFAULT_IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024

export type ImageCheck = { ok: true; size: number } | { ok: false; error: string }

export function hasImageExtension(path: string, extensions: readonly string[]): boolean {
  const ext = extname(path).slice(1).toLowerCase()
  return ext.length > 0 && extensions.some((e) => e.toLowerCase().replace(/^\./, '') === ext)
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
