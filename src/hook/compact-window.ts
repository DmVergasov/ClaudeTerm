import { homedir } from 'node:os'
import { join } from 'node:path'

/** a file's text, or null when it cannot be read */
export type ReadText = (path: string) => string | null

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null)

const MIN = 100_000
const MAX = 1_000_000
/** Claude Code takes any window into 100k to 1M */
const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, Math.round(n)))

/** a window in a settings file: a token count, "auto" (the model's own default), or nothing usable */
function settingWindow(v: unknown): number | 'auto' | null {
  if (v === 'auto') return 'auto'
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? clamp(v) : null
}

/** CLAUDE_CODE_AUTO_COMPACT_WINDOW: a token count, with k or M for thousands or millions; anything else is ignored */
export function envWindow(text: string | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(text ?? '')
  if (!m) return null
  const unit = m[2].toLowerCase() === 'k' ? 1_000 : m[2].toLowerCase() === 'm' ? 1_000_000 : 1
  return clamp(Number(m[1]) * unit)
}

/** a model id as Claude Code compares it with a modelSettings key: no [1m], no provider prefix, version or date */
function canonical(id: string): string {
  const s = id.toLowerCase().replace(/\[1m\]$/, '').replace(/@.*$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '')
  const at = s.indexOf('claude-')
  return at > 0 ? s.slice(at) : s
}

/** whether a modelSettings key names this model: the canonical name also matches its dated, [1m], Bedrock and Vertex spellings */
export function sameModel(modelId: string, key: string): boolean {
  return canonical(modelId) === canonical(key)
}

/** the window one settings file sets for the model: its modelSettings entry first, then its top-level key; undefined: none */
function fileWindow(text: string | null, modelId: string): number | 'auto' | undefined {
  let json: Obj | null = null
  try {
    json = obj(JSON.parse(text ?? 'null'))
  } catch {
    return undefined
  }
  if (!json) return undefined
  const perModel = obj(json.modelSettings)
  for (const [key, entry] of Object.entries(perModel ?? {})) {
    if (!sameModel(modelId, key)) continue
    const w = settingWindow(obj(entry)?.autoCompactWindow)
    if (w !== null) return w
  }
  return settingWindow(json.autoCompactWindow) ?? undefined
}

/**
 * The auto-compact window Claude Code uses for the model, in tokens, or null for the model's own default. Claude Code's
 * status line reports the model's whole context window (1M for a 1M model), while the conversation compacts at this window.
 * The order follows code.claude.com/docs/en/model-config#set-the-auto-compact-window: CLAUDE_CODE_AUTO_COMPACT_WINDOW,
 * then the project's local and shared settings, then the user's; in each file the model's own entry before the top-level key.
 * Managed settings and a per-launch --autocompact are not read.
 */
export function compactWindow(modelId: string, projectDir: string | null, env: NodeJS.ProcessEnv, read: ReadText): number | null {
  const fromEnv = envWindow(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  if (fromEnv !== null) return fromEnv
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.USERPROFILE || env.HOME || homedir(), '.claude')
  const files = [
    ...(projectDir ? [join(projectDir, '.claude', 'settings.local.json'), join(projectDir, '.claude', 'settings.json')] : []),
    join(configDir, 'settings.json')
  ]
  for (const file of files) {
    const w = fileWindow(read(file), modelId)
    if (w !== undefined) return w === 'auto' ? null : w
  }
  return null
}
