import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AgentModelInfo {
  model: string
  effort: string | null
}

export interface AgentMeta {
  description: string | null
  toolUseId: string | null
  background: boolean
}

const MAX_DESCRIPTION = 200

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

function parseObj(text: string): Obj | null {
  try {
    const v: unknown = JSON.parse(text)
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** Model and effort of an assistant transcript line; null for other lines and synthetic messages ("<synthetic>"). */
export function assistantInfo(line: string): AgentModelInfo | null {
  const o = parseObj(line)
  if (!o || o.type !== 'assistant' || !isObj(o.message)) return null
  const model = str(o.message.model)
  if (!model || model.startsWith('<')) return null
  return { model, effort: str(o.effort) ?? str(o.perTurnEffort) }
}

/** subagents/agent-<agentId>.meta.json written by Claude Code next to the subagent transcript. */
export function readAgentMeta(subagentDir: string, agentId: string): AgentMeta | null {
  let o: Obj | null
  try {
    o = parseObj(readFileSync(join(subagentDir, `agent-${agentId}.meta.json`), 'utf8'))
  } catch {
    return null
  }
  if (!o) return null
  return { description: str(o.description)?.slice(0, MAX_DESCRIPTION) ?? null, toolUseId: str(o.toolUseId), background: o.requestShape === 'background' }
}
