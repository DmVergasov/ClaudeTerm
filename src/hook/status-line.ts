import { isUuid, type StatusMessage } from '../shared/protocol'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** The fields ClaudeTerm shows, taken from the JSON Claude Code passes to a statusLine command (code.claude.com/docs/en/statusline). */
export function statusFromStatusLine(input: unknown, tabId: string): StatusMessage | null {
  const i = obj(input)
  const sessionId = i?.session_id
  const model = obj(i?.model)
  const id = str(model?.id)
  if (!i || !isUuid(sessionId) || !id) return null
  const cw = obj(i.context_window)
  const size = num(cw?.context_window_size)
  const usage = obj(cw?.current_usage)
  let context: StatusMessage['context'] = null
  if (usage && size !== null && size > 0) {
    // same input-only formula as used_percentage
    const usedTokens = (num(usage.input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0)
    context = { usedTokens, size, usedPct: num(cw?.used_percentage) ?? (usedTokens / size) * 100 }
  }
  const fiveHour = obj(obj(i.rate_limits)?.five_hour)
  const usedPct = num(fiveHour?.used_percentage)
  const resetsAt = num(fiveHour?.resets_at)
  return {
    v: 1,
    type: 'status',
    tabId,
    sessionId,
    model: { id, displayName: str(model?.display_name) ?? id },
    effort: str(obj(i.effort)?.level),
    context,
    fiveHour: usedPct !== null && resetsAt !== null ? { usedPct, resetsAt } : null
  }
}
