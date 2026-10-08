import { isAbsolute, resolve } from 'node:path'
import { PipeUnavailableError } from '../shared/pipe-client'
import type { PipeResponse, ShowDiffMessage } from '../shared/protocol'
import type { ReviewScope } from '../shared/review'
import type { ToolResult } from './show-image-tool'

export interface ShowDiffInput {
  scope?: ReviewScope
  from?: string
  to?: string
  paths?: string[]
  title?: string
}

export interface ShowDiffDeps {
  cwd: string
  tabId: string | null
  pipeName: string
  send(pipeName: string, msg: ShowDiffMessage): Promise<PipeResponse>
}

const MAX_PATHS = 100

export async function handleShowDiff(input: ShowDiffInput, deps: ShowDiffDeps): Promise<ToolResult> {
  if (!deps.tabId) return { text: 'show_diff works only in a ClaudeTerm Claude tab', isError: true }
  const from = input.from?.trim()
  const to = input.to?.trim()
  for (const [name, v] of [['from', from], ['to', to]] as const) {
    if (v !== undefined && (v === '' || v.startsWith('-'))) return { text: `${name} must be a git revision such as HEAD~3, a branch or a commit`, isError: true }
  }
  if (to !== undefined && from === undefined) return { text: 'to needs from: pass the revision to compare with', isError: true }
  const raw = input.paths ?? []
  if (raw.length > MAX_PATHS) return { text: `at most ${MAX_PATHS} paths`, isError: true }
  const title = input.title?.trim()
  const msg: ShowDiffMessage = {
    v: 1,
    type: 'show_diff',
    tabId: deps.tabId,
    cwd: deps.cwd,
    scope: from !== undefined ? null : input.scope ?? null,
    from: from ?? null,
    to: to ?? null,
    paths: raw.map((p) => (isAbsolute(p) ? p : resolve(deps.cwd, p))),
    title: title ? title.slice(0, 100) : null
  }
  let res: PipeResponse
  try {
    res = await deps.send(deps.pipeName, msg)
  } catch (e) {
    if (e instanceof PipeUnavailableError) return { text: 'ClaudeTerm is not running, so there is no panel to show the diff in', isError: true }
    return { text: `ClaudeTerm request failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
  return res.ok ? { text: res.info ?? 'Opened in the Changes panel.', isError: false } : { text: res.error, isError: true }
}
