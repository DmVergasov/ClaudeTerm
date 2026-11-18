/*
 * The coordinator's form results, and which of them count. The person answers a coordinator's question form in the window, either as
 * a chat card (main sees the answer) or in the coordinator's terminal (the answer is an AskUserQuestion result in the transcript). A
 * transcript result counts only when the tab's own hook reported the form and the window answered its dialog in time: a line written
 * into the transcript with nothing behind it never counts.
 */

import { QUESTIONS_MAX, FORM_ANSWER_MAX, FORM_QUESTION_MAX } from '../../shared/questions'
import type { Submit } from './person-input'
import { INPUT_SLACK_MS, normWords } from './person-words'

/** the form results and the form dialogs kept per tab: the latest this many */
export const FORMS_KEPT = 20
/** the slack for a paired device's clock: a form result counts for a question sent this long before its time */
export const FORM_SLACK_MS = 120_000

/** one question of a form with the person's answer */
export interface FormEntry {
  question: string
  answer: string
}

/** a form the person answered: its id, its time, and its questions with their answers */
export interface FormResult {
  id: string
  at: number
  answers: FormEntry[]
}

/** a question form a tab's dialog showed: its time and the texts of its questions */
export interface FormDialog {
  at: number
  questions: string[]
}

const sized = (text: string, max: number): boolean => text.length >= 1 && text.length <= max

/** the answers of a form as checked entries: 1 to QUESTIONS_MAX questions, each text and each answer a string within its bounds; null when not */
export function formEntries(answers: Record<string, unknown>): FormEntry[] | null {
  const entries = Object.entries(answers)
  if (entries.length < 1 || entries.length > QUESTIONS_MAX) return null
  const checked: FormEntry[] = []
  for (const [question, answer] of entries) {
    if (!sized(question, FORM_QUESTION_MAX) || typeof answer !== 'string' || !sized(answer, FORM_ANSWER_MAX)) return null
    checked.push({ question, answer })
  }
  return checked
}

/** a list kept per tab, newest last, at most FORMS_KEPT */
function pushKept<T>(map: Map<string, T[]>, tabId: string, item: T): void {
  const list = map.get(tabId) ?? []
  list.push(item)
  if (list.length > FORMS_KEPT) list.shift()
  map.set(tabId, list)
}

/**
 * the form results of each tab in memory: the card answers main saw (in the window or from claude.ai) and the forms the tab's hook
 * reported, the latest FORMS_KEPT of each
 */
export class FormRecord {
  private readonly answeredCards = new Map<string, FormResult[]>()
  private readonly reported = new Map<string, FormDialog[]>()
  private cardCount = 0

  /** a question card answered: its answers kept only when they are within bounds; otherwise nothing is kept */
  cardAnswered(tabId: string, answers: Record<string, unknown>, at: number): void {
    const entries = formEntries(answers)
    if (entries === null) return
    this.cardCount += 1
    pushKept(this.answeredCards, tabId, { id: `card:${this.cardCount}`, at, answers: entries })
  }

  /** a question form the tab's hook reported, with the texts of its questions */
  dialogOpened(tabId: string, questions: readonly string[], at: number): void {
    pushKept(this.reported, tabId, { at, questions: [...questions] })
  }

  cards(tabId: string): readonly FormResult[] {
    return this.answeredCards.get(tabId) ?? []
  }

  dialogs(tabId: string): readonly FormDialog[] {
    return this.reported.get(tabId) ?? []
  }

  drop(tabId: string): void {
    this.answeredCards.delete(tabId)
    this.reported.delete(tabId)
  }
}

/** whether a dialog's questions are the result's, as sets of texts equal after normWords */
function sameQuestions(questions: readonly string[], answers: readonly FormEntry[]): boolean {
  const asked = new Set(questions.map(normWords))
  const got = new Set(answers.map((a) => normWords(a.question)))
  return asked.size === got.size && [...got].every((q) => asked.has(q))
}

/**
 * whether a dialog backs a transcript result: the same questions, shown no later than the answer, and the window answered it in time. The
 * answer must come before the tab's next dialog (`next`): a later submit answers that dialog, or none, never this one. Only a submit made in
 * a dialog backs it (`dialog`, which a dialog submit always has with no text): a prompt submit, a slash command or a bash line typed after the
 * form was dismissed answers nothing.
 */
function backs(dialog: FormDialog, result: FormResult, submits: readonly Submit[], next: number | null): boolean {
  if (dialog.at > result.at || !sameQuestions(dialog.questions, result.answers)) return false
  return submits.some((s) => s.dialog === true && s.texts === null && s.at >= dialog.at && s.at <= result.at + INPUT_SLACK_MS && (next === null || s.at < next))
}

/**
 * the form results that count: every card answer main saw, then the transcript's results that a dialog backs. A dialog backs one result
 * only, the earliest after it that it backs, so a later result of the same questions needs a dialog of its own: a result is counted once
 */
export function countedForms(o: { cards: readonly FormResult[]; transcript: readonly FormResult[]; dialogs: readonly FormDialog[]; submits: readonly Submit[] }): FormResult[] {
  const counted = new Set<number>()
  const dialogs = [...o.dialogs].sort((a, b) => a.at - b.at)
  for (const dialog of dialogs) {
    // the tab's next recorded dialog: the first one opened after this one
    const next = dialogs.find((d) => d.at > dialog.at)?.at ?? null
    let best = -1
    o.transcript.forEach((result, i) => {
      if (counted.has(i) || !backs(dialog, result, o.submits, next)) return
      if (best === -1 || result.at < o.transcript[best]!.at) best = i
    })
    if (best !== -1) counted.add(best)
  }
  return [...o.cards, ...o.transcript.filter((_, i) => counted.has(i))]
}

export type FormMatch = { ok: true; answers: FormEntry[] } | { ok: false; missing: string[]; found: string[] }

/**
 * the person's answers to the questions asked, from the forms at or after `since`, newest first: each asked text takes the first entry
 * whose question reads the same (equal after normWords). When one asked text is in none of them, `missing` holds the texts not found
 * and `found` the distinct questions the forms hold, newest first
 */
export function matchForm(o: { asked: readonly string[]; forms: readonly FormResult[]; since: number }): FormMatch {
  const entries = o.forms
    .filter((f) => f.at >= o.since)
    .sort((a, b) => b.at - a.at)
    .flatMap((f) => f.answers)
  const answers: FormEntry[] = []
  const missing: string[] = []
  for (const asked of o.asked) {
    const hit = entries.find((e) => normWords(e.question) === normWords(asked))
    if (hit === undefined) missing.push(asked)
    else answers.push({ question: hit.question, answer: hit.answer })
  }
  if (missing.length > 0) return { ok: false, missing, found: [...new Set(entries.map((e) => e.question))] }
  return { ok: true, answers }
}
