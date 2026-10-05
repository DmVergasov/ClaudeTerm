import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { checkImageFile } from '../shared/image-file'
import type { ImageHub } from './image-hub'

export const IMG_SCHEME = 'ctimg'

export function registerImgScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: IMG_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
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
  if (!card) return null
  const check = await checkImageFile(card.path, extensions)
  return check.ok ? { path: card.path } : null
}

export function handleImgProtocol(hub: ImageHub, extensions: () => string[]): void {
  protocol.handle(IMG_SCHEME, async (req) => {
    const hit = await resolveImgRequest(req.url, hub, extensions())
    if (!hit) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(hit.path).toString())
  })
}
