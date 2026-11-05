import type { ReviewLine } from '../shared/review'

/** a document as lines of context, numbered from 1: the shape a Changes hunk has, so the same Markdown code formats it */
export function docLines(text: string): ReviewLine[] {
  if (text === '') return []
  const texts = text.split(/\r?\n/)
  if (texts[texts.length - 1] === '') texts.pop()
  return texts.map((t, i) => ({ kind: 'context', text: t, oldNo: i + 1, newNo: i + 1 }))
}
