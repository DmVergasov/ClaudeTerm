import type { PersonWordsWake } from '../../shared/report-wake'
import { labelOf } from '../util'

const el = (tag: string, className: string, text = ''): HTMLElement => {
  const e = document.createElement(tag)
  e.className = className
  e.textContent = text
  return e
}

/**
 * the person's words a coordinator passed on, as the session's chat draws them: a card in the agents block's look, the coordinator's
 * question quiet above the words and the coordinator's task under them; every text is set as text
 */
export function wordsCard(w: PersonWordsWake): HTMLElement {
  const box = el('div', 'chat-agents coord-words')
  const head = el('div', 'chat-agents-head')
  const title = el('span', 'coord-words-title')
  const label = document.createElement('b')
  label.textContent = 'Your words'
  title.append(label, ` · through ${labelOf(w.coordinator)}`)
  head.append(title)
  box.append(head)
  if (w.context !== null) box.append(el('div', 'coord-words-context', w.context))
  box.append(el('div', 'coord-words-words', w.words), el('div', 'coord-words-task', w.task))
  return box
}
