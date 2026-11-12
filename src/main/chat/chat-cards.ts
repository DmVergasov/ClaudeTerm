import type { ChatAnswer, ChatCard, ChatQuestion, ChatSuggestion } from '../../shared/chat'
import { cap, toolSubject } from './chat-model'

// Claude Code's permission asks as cards, and the user's answers as what the SDK takes back

/** a card's strings and a diff's sides are cut to this (the card's strings: 64 KiB) */
const TEXT_CAP = 64 * 1024
const CLAIM = 'Claude wants to '
const MAX_QUESTIONS = 4
const MAX_OPTIONS = 8
const ALWAYS_DESTINATIONS = ['localSettings', 'projectSettings', 'userSettings']
/** a suggestion's label is cut to this, and a card offers this many suggestions at most */
const LABEL_CAP = 500
const MAX_SUGGESTIONS = 20

export interface PermissionAsk { toolName: string; input: Record<string, unknown>; title?: string; description?: string; displayName?: string; suggestions?: unknown[]; defaultToNo?: boolean; suppressAlwaysAllowRule?: boolean; folder: string }

export type SdkPermissionResult = { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string; interrupt?: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, TEXT_CAP) : null)

/** the card's words for a permission suggestion; null: a suggestion this version cannot word */
export function suggestionLabel(s: unknown): string | null {
  if (!isObj(s)) return null
  if (s.type === 'setMode') return s.mode === 'acceptEdits' ? 'Allow edits for this session' : null
  if (s.type === 'addRules') {
    if (s.behavior !== 'allow' || !Array.isArray(s.rules)) return null
    const rules = s.rules.flatMap(r => {
      const name = isObj(r) ? str(r.toolName) : null
      if (name === null) return []
      const content = isObj(r) ? str(r.ruleContent) : null
      return [content === null ? name : `${name}(${content})`]
    })
    if (rules.length === 0) return null
    const rule = rules.join(', ')
    if (s.destination === 'session') return `Allow ${rule} for this session`
    if (typeof s.destination === 'string' && ALWAYS_DESTINATIONS.includes(s.destination)) return `Always allow ${rule}`
    return null
  }
  if (s.type === 'addDirectories') {
    if (!Array.isArray(s.directories)) return null
    const dirs = s.directories.filter((d): d is string => typeof d === 'string')
    return dirs.length === 0 ? null : `Allow access to ${dirs.join(', ')} for this session`
  }
  return null
}

/** the card for one ask: a question, a plan, or a permission (also for a malformed AskUserQuestion) */
export function cardFor(ask: PermissionAsk): ChatCard {
  const input = isObj(ask.input) ? ask.input : {}
  if (ask.toolName === 'ExitPlanMode') return { type: 'plan', plan: str(input.plan) ?? '' }
  if (ask.toolName === 'AskUserQuestion') {
    const questions = questionsOf(input.questions)
    if (questions !== null) return { type: 'question', questions }
  }
  return permissionCard(ask, input)
}

/** the questions of an AskUserQuestion input; null when it is malformed */
function questionsOf(v: unknown): ChatQuestion[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_QUESTIONS) return null
  const out: ChatQuestion[] = []
  for (const q of v) {
    if (!isObj(q)) return null
    const question = str(q.question)
    if (question === null || !Array.isArray(q.options) || q.options.length === 0 || q.options.length > MAX_OPTIONS) return null
    const options: ChatQuestion['options'] = []
    for (const o of q.options) {
      const label = isObj(o) ? str(o.label) : null
      if (label === null || !isObj(o)) return null
      options.push({ label, description: str(o.description) ?? '' })
    }
    out.push({ question, header: str(q.header) ?? '', multiSelect: q.multiSelect === true, options })
  }
  if (new Set(out.map(q => q.question)).size !== out.length) return null
  return out
}

/** the title a permission card shows when the ask has none of its own */
function titleFor(toolName: string, subject: string): string {
  if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) return `${CLAIM}edit ${subject}`
  if (toolName === 'Bash') return `${CLAIM}run a command`
  if (toolName === 'WebFetch') return `${CLAIM}fetch ${subject}`
  const parts = toolName.split('__')
  if (toolName.startsWith('mcp__') && parts.length >= 3 && parts[1] !== '' && parts.slice(2).join('__') !== '') {
    return `${CLAIM}use ${parts[1]} · ${parts.slice(2).join('__')}`
  }
  return `${CLAIM}use ${toolName}`
}

function permissionCard(ask: PermissionAsk, input: Record<string, unknown>): ChatCard {
  const subject = toolSubject(ask.toolName, input, ask.folder)
  return {
    type: 'permission',
    tool: ask.toolName,
    title: str(ask.title) ?? titleFor(ask.toolName, subject),
    subject,
    description: str(ask.description) ?? str(input.description),
    diff: diffFor(ask.toolName, input),
    suggestions: ask.suppressAlwaysAllowRule ? [] : suggestionsOf(ask.suggestions),
    defaultToNo: ask.defaultToNo === true,
  }
}

/** the file change an Edit or a Write shows; null for the other tools */
function diffFor(toolName: string, input: Record<string, unknown>): { path: string; before: string; after: string } | null {
  const path = str(input.file_path)
  if (path === null) return null
  if (toolName === 'Edit') {
    const before = str(input.old_string)
    const after = str(input.new_string)
    return before === null || after === null ? null : { path, before, after }
  }
  if (toolName === 'Write') {
    const after = str(input.content)
    return after === null ? null : { path, before: '', after }
  }
  return null
}

/** the suggestions this version can word, each with its index in the ask's list */
function suggestionsOf(v: unknown): ChatSuggestion[] {
  if (!Array.isArray(v)) return []
  const out: ChatSuggestion[] = []
  v.forEach((s, index) => {
    const label = suggestionLabel(s)
    if (label !== null && out.length < MAX_SUGGESTIONS) out.push({ index, label: cap(label, LABEL_CAP) })
  })
  return out
}

/** what the SDK takes back for the user's answer to a card; null: the answer does not fit the card */
export function resultFor(ask: PermissionAsk, card: ChatCard, answer: ChatAnswer): SdkPermissionResult | null {
  if (card.type === 'permission') return permissionResult(ask, card, answer)
  if (card.type === 'question') return questionResult(ask, card, answer)
  if (card.type === 'plan') return planResult(ask, answer)
  return null
}

function permissionResult(ask: PermissionAsk, card: Extract<ChatCard, { type: 'permission' }>, answer: ChatAnswer): SdkPermissionResult | null {
  if (answer.type !== 'permission') return null
  if (answer.choice === 'deny') return { behavior: 'deny', message: answer.message ?? 'The user denied this.' }
  if (answer.suggestion === null) return { behavior: 'allow', updatedInput: ask.input }
  if (!card.suggestions.some(s => s.index === answer.suggestion)) return null
  const raw = ask.suggestions?.[answer.suggestion]
  if (raw === undefined) return null
  return { behavior: 'allow', updatedInput: ask.input, updatedPermissions: [raw] }
}

function questionResult(ask: PermissionAsk, card: Extract<ChatCard, { type: 'question' }>, answer: ChatAnswer): SdkPermissionResult | null {
  if (answer.type !== 'question') return null
  if (answer.answers === null) return { behavior: 'deny', message: 'The user declined to answer.' }
  const given = answer.answers
  if (Object.keys(given).length !== card.questions.length) return null
  const answers: Record<string, string> = {}
  for (const q of card.questions) {
    if (!Object.prototype.hasOwnProperty.call(given, q.question)) return null
    const value = given[q.question]
    if (Array.isArray(value) && !q.multiSelect) return null
    const text = textOf(value)
    if (text === null) return null
    answers[q.question] = text
  }
  return { behavior: 'allow', updatedInput: { ...ask.input, answers } }
}

/** an answer as the text the SDK takes: a multi-select's labels joined with a comma */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string')) return value.join(', ')
  return null
}

function planResult(ask: PermissionAsk, answer: ChatAnswer): SdkPermissionResult | null {
  if (answer.type !== 'plan') return null
  if (answer.choice === 'keep-planning') return { behavior: 'deny', message: answer.message ?? 'Keep planning.' }
  const mode = answer.choice === 'accept-edits' ? 'acceptEdits' : 'default'
  return { behavior: 'allow', updatedInput: ask.input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] }
}

/** the line a card leaves in the transcript once it is answered, cut to the card cap: a member takes the card push whole */
export function answeredLine(card: ChatCard, answer: ChatAnswer): string {
  const line = answeredWords(card, answer)
  if (line.length <= TEXT_CAP) return line
  // never leave the high half of a surrogate pair at the cut
  const end = line.charCodeAt(TEXT_CAP - 1) >= 0xd800 && line.charCodeAt(TEXT_CAP - 1) <= 0xdbff ? TEXT_CAP - 1 : TEXT_CAP
  return line.slice(0, end)
}

function answeredWords(card: ChatCard, answer: ChatAnswer): string {
  if (card.type === 'question' && answer.type === 'question') {
    if (answer.answers === null) return 'You declined to answer'
    const given = answer.answers
    const texts = card.questions.flatMap(q => {
      const text = Object.prototype.hasOwnProperty.call(given, q.question) ? textOf(given[q.question]) : null
      return text === null ? [] : [text]
    })
    return `You answered: ${texts.join(', ')}`
  }
  if (card.type === 'permission' && answer.type === 'permission') {
    const what = card.title.startsWith(CLAIM) ? card.title.slice(CLAIM.length) : card.title
    if (answer.choice === 'deny') return `Denied: ${what}`
    const suggestion = answer.suggestion === null ? undefined : card.suggestions.find(s => s.index === answer.suggestion)
    if (suggestion === undefined) return `Allowed: ${what}`
    return suggestion.label.startsWith('Always allow') ? `Always allowed: ${what}` : `Allowed for this session: ${what}`
  }
  if (card.type === 'plan' && answer.type === 'plan') return answer.choice === 'keep-planning' ? 'Kept planning' : 'Plan approved'
  if (card.type === 'dialog' && answer.type === 'dialog') {
    const choice = card.choices.find(c => c.id === answer.choice)
    return choice === undefined ? 'Dismissed' : choice.label
  }
  return 'Answered'
}
