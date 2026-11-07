import { type CustomScheme, net, protocol } from 'electron'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkImageFile } from '../shared/image-file'
import type { ImageHub } from './image-hub'
import type { RemoteImages } from './sync/remote-actions'

export const IMG_SCHEME = 'ctimg'

/** the bytes of an image and their MIME type */
export interface ImageBytes {
  data: Buffer
  type: string
}

/** the bytes of a card of another device's tab at a version; null when the card is not one this window asks for */
export type RemoteImageSource = (id: string, version: number) => Promise<ImageBytes | null>

const IMAGE_MIME = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp']
])

/** the MIME type of an image file by its extension; null for a type the image panel does not show */
export function imageMime(path: string): string | null {
  return IMAGE_MIME.get(extname(path).slice(1).toLowerCase()) ?? null
}

/** Electron takes the privileged schemes once per app: the other schemes of the app go in `extra`. */
export function registerImgScheme(extra: CustomScheme[] = []): void {
  protocol.registerSchemesAsPrivileged([{ scheme: IMG_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }, ...extra])
}

/** Maps a ctimg:// request to a servable file path, or null (404). */
export async function resolveImgRequest(url: string, hub: ImageHub, extensions: string[]): Promise<{ path: string } | null> {
  let id: string
  try {
    id = new URL(url).hostname
  } catch {
    return null
  }
  const card = hub.get(id)
  if (!card || card.kind !== 'image') return null
  const check = await checkImageFile(card.path, extensions)
  return check.ok ? { path: card.path } : null
}

/** the card id and the version a ctimg:// URL names; null when the URL names no id or the version is not a whole number from 1 */
export function parseImgUrl(url: string): { id: string; version: number } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const v = u.searchParams.get('v')
  if (!u.hostname || v === null || !/^[1-9]\d*$/.test(v)) return null
  const version = Number(v)
  return Number.isSafeInteger(version) ? { id: u.hostname, version } : null
}

/**
 * What a ctimg:// request is answered with: a file of a card this device has (resolveImgRequest), else the bytes `remote`
 * gives for the card's version. A card this device has is never asked of another device; null is a 404.
 */
export async function imageResponse(url: string, hub: ImageHub, extensions: string[], remote?: RemoteImageSource): Promise<{ path: string } | ImageBytes | null> {
  const local = await resolveImgRequest(url, hub, extensions)
  if (local) return local
  const req = parseImgUrl(url)
  if (!remote || !req || hub.get(req.id)) return null
  return remote(req.id, req.version)
}

/**
 * The remote source of the ctimg protocol: a card this window knows (from its device's last push) at the version asked
 * for, its bytes read from the device of the card's tab once and kept by `images`. Any other id answers null, and no call goes out.
 */
export function remoteCardSource(
  images: Pick<RemoteImages, 'card' | 'cached' | 'store'>,
  bytesOf: (tabId: string, cardId: string) => Promise<{ version: number; data: Buffer } | null>
): RemoteImageSource {
  return async (id, version) => {
    const card = images.card(id)
    if (!card || card.version !== version || card.kind !== 'image') return null
    const type = imageMime(card.path)
    if (!type) return null
    const kept = images.cached(id, version)
    if (kept) return { data: kept, type }
    const got = await bytesOf(card.tabId, id)
    if (!got || got.version !== version) return null
    images.store(id, version, got.data)
    return { data: got.data, type }
  }
}

export function handleImgProtocol(hub: ImageHub, extensions: () => string[], remote?: RemoteImageSource): void {
  protocol.handle(IMG_SCHEME, async (req) => {
    const hit = await imageResponse(req.url, hub, extensions(), remote)
    if (!hit) return new Response('not found', { status: 404 })
    if ('path' in hit) return net.fetch(pathToFileURL(hit.path).toString())
    return new Response(new Uint8Array(hit.data), { headers: { 'content-type': hit.type } })
  })
}
