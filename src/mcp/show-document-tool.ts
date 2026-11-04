import { isAbsolute, resolve } from 'node:path'
import { checkDocFile } from '../shared/doc-file'
import { MAX_DOC_TITLE } from '../shared/docs'
import { PipeUnavailableError } from '../shared/pipe-client'
import type { PipeResponse, ShowDocumentMessage } from '../shared/protocol'
import type { ToolResult } from './show-image-tool'

export interface ShowDocumentDeps {
  cwd: string
  tabId: string | null
  pipeName: string
  send(pipeName: string, msg: ShowDocumentMessage): Promise<PipeResponse>
}

export async function handleShowDocument(input: { path: string; title?: string }, deps: ShowDocumentDeps): Promise<ToolResult> {
  if (!deps.tabId) return { text: 'show_document works only in a ClaudeTerm Claude tab', isError: true }
  const abs = isAbsolute(input.path) ? input.path : resolve(deps.cwd, input.path)
  const check = await checkDocFile(abs)
  if (!check.ok) return { text: check.error, isError: true }
  const title = input.title?.trim()
  const msg: ShowDocumentMessage = { v: 1, type: 'show_document', tabId: deps.tabId, path: abs, title: title ? title.slice(0, MAX_DOC_TITLE) : null }
  let res: PipeResponse
  try {
    res = await deps.send(deps.pipeName, msg)
  } catch (e) {
    if (e instanceof PipeUnavailableError) return { text: `ClaudeTerm is not running; the document is at ${abs}`, isError: false }
    return { text: `ClaudeTerm request failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
  return res.ok ? { text: res.info ?? 'Opened in the Docs panel.', isError: false } : { text: res.error, isError: true }
}
