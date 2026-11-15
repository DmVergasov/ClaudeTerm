import type { ChatItem } from '../../shared/chat'
import { outcomeText } from '../../shared/report-wake'
import { icon } from '../icons'
import { clockOf, labelOf } from '../util'
import { chatMarkdownHtml, markdownClick } from './chat-markdown'
import type { ItemCallbacks } from './chat-items'

/** a report's card as the column draws it: the report's item, without its kind and id */
export type ReportCardData = Omit<Extract<ChatItem, { kind: 'report' }>, 'kind' | 'id'>

/** the card head's label: the session's label, and the name of its device after it when the report came from another device */
export const reportLabel = (card: ReportCardData): string => (card.device ? `${labelOf(card.name)} · ${card.device}` : labelOf(card.name))

const el = (tag: string, className: string, text = ''): HTMLElement => {
  const e = document.createElement(tag)
  e.className = className
  e.textContent = text
  return e
}

const button = (label: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', 'chat-button', label) as HTMLButtonElement
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

/**
 * A report of a session attached to the coordinator, as a card in its chat, drawn like the agents block. The head has the state
 * icon, the session's label with how its task ended, the time it came in when it is known, and Open session and Resolve when the
 * card has buttons. The body is the report's text as Markdown, with its paths. The name and the reason are set as text.
 */
export function reportCard(card: ReportCardData, cb: ItemCallbacks): HTMLElement {
  const box = el('div', 'chat-agents coord-report')
  box.dataset.outcome = card.outcome
  const head = el('div', 'chat-agents-head')
  const state = el('span', `chat-step-state ${card.outcome === 'finished' ? 'done' : card.outcome === 'failed' ? 'failed' : 'stopped'}`)
  state.innerHTML = icon(card.outcome === 'finished' ? 'check' : 'x', 13)
  const title = el('span', 'coord-report-title')
  const label = document.createElement('b')
  label.textContent = reportLabel(card)
  title.append(label, ` · ${outcomeText(card.outcome, card.reason)}${card.at === null ? '' : ` · ${clockOf(card.at)}`}`)
  const acts = el('span', 'coord-report-acts')
  if (cb.report !== null) {
    const report = cb.report
    acts.append(button('Open session', () => report.open(card.ref, card.name)), button('Resolve', () => report.resolve(card.ref, card.name)))
  }
  head.append(state, title, acts)
  const body = el('div', 'coord-report-body chat-text')
  body.innerHTML = chatMarkdownHtml(card.text, { paths: true })
  body.addEventListener('click', (e) => markdownClick(e, cb))
  box.append(head, body)
  return box
}
