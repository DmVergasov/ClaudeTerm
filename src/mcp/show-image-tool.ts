import { isAbsolute, resolve } from 'node:path'
import { checkImageFile, DEFAULT_IMAGE_EXTENSIONS } from '../shared/image-file'
import { PipeUnavailableError } from '../shared/pipe-client'
import type { PipeResponse, ShowImageMessage } from '../shared/protocol'

export interface ShowImageDeps {
  cwd: string
  tabId: string | null
  pipeName: string
  send(pipeName: string, msg: ShowImageMessage): Promise<PipeResponse>
}

export interface ToolResult {
  text: string
  isError: boolean
}

export async function handleShowImage(input: { path: string; caption?: string }, deps: ShowImageDeps): Promise<ToolResult> {
  const abs = isAbsolute(input.path) ? input.path : resolve(deps.cwd, input.path)
  const check = await checkImageFile(abs, DEFAULT_IMAGE_EXTENSIONS)
  if (!check.ok) return { text: check.error, isError: true }
  let res: PipeResponse
  try {
    res = await deps.send(deps.pipeName, { v: 1, type: 'show_image', tabId: deps.tabId, path: abs, caption: input.caption ?? null })
  } catch (e) {
    if (e instanceof PipeUnavailableError) return { text: `ClaudeTerm is not running; image is at ${abs}`, isError: false }
    return { text: `ClaudeTerm request failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
  return res.ok ? { text: `Shown in ClaudeTerm: ${abs}`, isError: false } : { text: `ClaudeTerm rejected the image: ${res.error}`, isError: true }
}
