import type { ChatAnswer, ChatCard, ChatItem } from '../../shared/chat'
import { chatMarkdownHtml, markdownClick } from './chat-markdown'

// The cards of the conversation: Claude's questions, permission requests and plans, drawn as the boards show them. Every
// string from Claude goes in as text, except a plan's Markdown. A card handles the keys pressed on it: its listeners sit on
// the card, so a key pressed in the composer never reaches it, and a key whose target is outside it is none of its business.

export interface CardCallbacks {
  /** resolves false when main refuses the answer (the card is stale), and the card is live again */
  answer(cardId: string, a: ChatAnswer): void | Promise<boolean>
  revealChange(path: string): void
  /** a web link Claude wrote, opened in the browser (a plan card's links behave as a message's) */
  openExternal(url: string): void
  copy(text: string): void
}

type CardItem = Extract<ChatItem, { kind: 'card' }>
type Send = (a: ChatAnswer) => void

const el = (tag: string, className: string, text = ''): HTMLElement => {
  const e = document.createElement(tag)
  e.className = className
  e.textContent = text
  return e
}

/** a card's button: its label, and its key badge when it has one */
function button(label: string, className: string, badge: string | null): HTMLButtonElement {
  const b = el('button', `chat-card-btn ${className}`) as HTMLButtonElement
  b.type = 'button'
  // one line, cut with an ellipsis: the title holds the whole label
  b.title = label
  b.append(el('span', 'chat-card-label', label))
  if (badge !== null) b.append(el('span', 'chat-card-key', badge))
  return b
}

/** a card answers once: the first answer goes out, and a refused one makes the card answerable again */
function answerOnce(id: string, cb: CardCallbacks): Send {
  let sent = false
  return (a) => {
    if (sent) return
    sent = true
    const pending = cb.answer(id, a) as unknown as PromiseLike<boolean> | undefined
    if (typeof pending?.then === 'function') {
      pending.then((ok) => { if (!ok) sent = false }, () => { sent = false })
    }
  }
}

/** a key the card takes as its own: not a chord (the app's tab keys are chords), not a repeat, not part of an IME composition */
const plainKey = (e: KeyboardEvent): boolean => !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !e.isComposing
/**
 * A held Enter or Space repeats: on a focused card button it would click the button again and again, and a key held down
 * from the composer must not answer a card. The repeat is stopped here, before the button's own click.
 */
const heldPress = (e: KeyboardEvent): boolean => {
  if (!e.repeat) return false
  if (e.key === 'Enter') return true
  // a held Space in a text box types its spaces: only a button or an option takes the repeat as no press
  return e.key === ' ' && e.target instanceof HTMLElement && e.target.closest('button, [role="option"]') !== null
}

/** a text's lines, without the carriage returns of a CRLF file; an empty text has none */
const linesOf = (s: string): string[] => (s === '' ? [] : s.split('\n').map((line) => line.replace(/\r$/, '')))

/** the card of one card item; an answered card is its one line */
export function renderCard(item: CardItem, cb: CardCallbacks): HTMLElement {
  if (item.answered !== null) return el('div', 'chat-card answered', item.answered)
  const send = answerOnce(item.id, cb)
  switch (item.card.type) {
    case 'question': return questionCard(item.card, send)
    case 'permission': return permissionCard(item.card, send, cb)
    case 'plan': return planCard(item.card, send, cb)
    case 'dialog': return el('div', 'chat-quiet', `Dialog: ${item.card.kind}`)
  }
}

/** the line a card waiting behind the oldest one shows, folded under it */
export function waitingCard(more: number): HTMLElement {
  return el('div', 'chat-card-waiting', more === 1 ? '1 more question waiting' : `${more} more questions waiting`)
}

/** focuses the control a card's keys start from: the one with data-start (the first option, Allow once, Deny, Approve) */
export function focusCard(box: HTMLElement): void {
  box.querySelector<HTMLElement>('[data-start]')?.focus()
}

type QuestionCard = Extract<ChatCard, { type: 'question' }>

/**
 * The question card: one tab per question when there are several, the question, its options (digits pick, Enter confirms),
 * an own answer, and Skip with Next or, on the last question, Submit. Esc dismisses the card.
 */
function questionCard(card: QuestionCard, send: Send): HTMLElement {
  const box = el('div', 'chat-card chat-card-question')
  const count = card.questions.length
  // per question: the picked options (0-based) and the typed answer
  const picks: Set<number>[] = card.questions.map(() => new Set<number>())
  const typed: string[] = card.questions.map(() => '')
  let index = 0

  // what a question holds now: the typed text, else the picked labels; null when it holds none
  const valueOf = (i: number): string | string[] | null => {
    const q = card.questions[i]!
    const text = typed[i]!.trim()
    if (text !== '') return text
    const labels = [...picks[i]!].sort((a, b) => a - b).map((o) => q.options[o]!.label)
    if (labels.length === 0) return null
    return q.multiSelect ? labels : labels[0]!
  }

  const submit = (): void => {
    const answers: Record<string, string | string[]> = {}
    card.questions.forEach((q, i) => { answers[q.question] = valueOf(i) ?? '' })
    send({ type: 'question', answers })
  }
  const advance = (): void => {
    if (index < count - 1) {
      index += 1
      layout()
    } else {
      submit()
    }
  }
  const confirm = (): void => {
    if (valueOf(index) !== null) advance()
  }
  // a skipped question holds no answer, and goes on without one
  const skip = (): void => {
    picks[index]!.clear()
    typed[index] = ''
    advance()
  }
  const pick = (o: number): void => {
    const q = card.questions[index]!
    const set = picks[index]!
    if (q.multiSelect && set.has(o)) {
      set.delete(o)
    } else {
      if (!q.multiSelect) set.clear()
      set.add(o)
    }
    typed[index] = ''
    layout()
  }

  const head = el('div', 'chat-card-head', 'Claude has a question')
  const body = el('div', 'chat-card-body')
  const foot = el('div', 'chat-card-foot')
  box.append(head, body, foot)

  // the picks' look changes in place, so the own answer being typed in is not drawn again
  const paintPicks = (): void => {
    body.querySelectorAll<HTMLButtonElement>('.chat-card-option').forEach((b, o) => {
      const picked = picks[index]!.has(o)
      b.classList.toggle('picked', picked)
      b.setAttribute('aria-pressed', String(picked))
    })
  }

  // the card is drawn again for each change of question or pick; the focus goes back to the control it was on
  const layout = (): void => {
    const had = box.contains(document.activeElement)
    const key = had ? (document.activeElement as HTMLElement).dataset.key : undefined
    const q = card.questions[index]!
    head.replaceChildren('Claude has a question')
    body.replaceChildren()
    foot.replaceChildren()

    if (count > 1) {
      const tabs = el('div', 'chat-card-tabs')
      card.questions.forEach((other, i) => {
        const tab = el('button', i === index ? 'chat-card-tab on' : 'chat-card-tab', other.header !== '' ? other.header : String(i + 1)) as HTMLButtonElement
        tab.type = 'button'
        tab.dataset.key = `tab-${i}`
        tab.addEventListener('click', () => {
          index = i
          layout()
        })
        tabs.append(tab)
      })
      head.append(tabs)
    }
    body.append(el('div', 'chat-card-question-text', q.question))

    const options = el('div', 'chat-card-options')
    q.options.forEach((opt, o) => {
      const picked = picks[index]!.has(o)
      const b = el('button', picked ? 'chat-card-option picked' : 'chat-card-option') as HTMLButtonElement
      b.type = 'button'
      b.setAttribute('aria-pressed', String(picked))
      b.dataset.key = `opt-${o}`
      if (o === 0) b.dataset.start = ''
      const text = el('span', 'chat-card-option-text')
      text.append(el('span', 'chat-card-option-label', opt.label))
      if (opt.description !== '') text.append(el('span', 'chat-card-option-desc', opt.description))
      b.append(el('span', q.multiSelect ? 'chat-card-check' : 'chat-card-radio'), text, el('span', 'chat-card-option-num', String(o + 1)))
      b.addEventListener('click', () => pick(o))
      options.append(b)
    })
    body.append(options)

    const own = document.createElement('input')
    own.type = 'text'
    own.className = 'chat-card-own'
    own.placeholder = 'Or type your own answer…'
    own.value = typed[index]!
    own.dataset.key = 'own'
    own.addEventListener('input', () => {
      typed[index] = own.value
      // a typed answer replaces the picks
      if (own.value.trim() !== '' && picks[index]!.size > 0) {
        picks[index]!.clear()
        paintPicks()
      }
    })
    body.append(own)

    const skipButton = button('Skip', 'chat-card-ghost', null)
    skipButton.dataset.key = 'skip'
    skipButton.addEventListener('click', skip)
    const nextButton = button(index === count - 1 ? 'Submit' : 'Next', 'primary', null)
    nextButton.dataset.key = 'next'
    nextButton.addEventListener('click', () => (valueOf(index) === null ? skip() : confirm()))
    foot.append(el('span', 'chat-card-hint', `1–${q.options.length} to pick · Enter to confirm · Esc to dismiss`), skipButton, nextButton)

    if (had) {
      const again = key === undefined ? null : box.querySelector<HTMLElement>(`[data-key="${key}"]`)
      ;(again ?? box.querySelector<HTMLElement>('[data-start]'))?.focus()
    }
  }

  box.addEventListener('keydown', (e) => {
    if (heldPress(e)) {
      e.preventDefault()
      return
    }
    if (!plainKey(e)) return
    const target = e.target as HTMLElement
    if (e.key === 'Escape') {
      e.preventDefault()
      send({ type: 'question', answers: null })
      return
    }
    if (e.key === 'Enter') {
      // a footer button or a tab does its own click
      if (target instanceof HTMLButtonElement && !target.classList.contains('chat-card-option')) return
      e.preventDefault()
      confirm()
      return
    }
    if (target instanceof HTMLInputElement) return
    const n = Number(e.key)
    if (/^[1-9]$/.test(e.key) && n <= card.questions[index]!.options.length) {
      e.preventDefault()
      pick(n - 1)
    }
  })

  layout()
  return box
}

type PermissionCard = Extract<ChatCard, { type: 'permission' }>

/**
 * The permission card: the title; an edit's diff (the removed and added lines, the path a button that reveals the change) or
 * a command in monospace with its description; Allow once, one button per suggestion, Deny (Esc), and a box that denies with
 * its text. Digits press the buttons in order, unless the request defaults to no; Enter takes the focused button.
 */
function permissionCard(card: PermissionCard, send: Send, cb: CardCallbacks): HTMLElement {
  const box = el('div', 'chat-card chat-card-permission')
  const deny: ChatAnswer = { type: 'permission', choice: 'deny', suggestion: null, message: null }
  box.append(el('div', 'chat-card-head', card.title))

  const body = el('div', 'chat-card-body')
  if (card.diff !== null) {
    body.append(diffView(card.diff, (path) => cb.revealChange(path)))
  } else {
    if (card.subject !== '') body.append(el('div', 'chat-card-command', card.subject))
    if (card.description !== null && card.description !== '') body.append(el('div', 'chat-card-desc', card.description))
  }
  box.append(body)

  // the buttons the digit keys press, in order: 1 for Allow once, then one per suggestion
  const choices: HTMLButtonElement[] = []
  const badge = (): string | null => (card.defaultToNo ? null : String(choices.length + 1))
  const actions = el('div', 'chat-card-actions')
  const allow = button('Allow once', 'primary', badge())
  allow.addEventListener('click', () => send({ type: 'permission', choice: 'once', suggestion: null, message: null }))
  choices.push(allow)
  actions.append(allow)
  for (const s of card.suggestions) {
    const b = button(s.label, 'chat-card-ghost', badge())
    b.addEventListener('click', () => send({ type: 'permission', choice: 'once', suggestion: s.index, message: null }))
    choices.push(b)
    actions.append(b)
  }
  const denyButton = button('Deny', 'chat-card-ghost', 'Esc')
  denyButton.addEventListener('click', () => send(deny))
  actions.append(denyButton)
  ;(card.defaultToNo ? denyButton : allow).dataset.start = ''
  box.append(actions)

  const message = document.createElement('input')
  message.type = 'text'
  message.className = 'chat-card-message'
  message.placeholder = 'Tell Claude what to do instead…'
  box.append(message)

  box.addEventListener('keydown', (e) => {
    if (heldPress(e)) {
      e.preventDefault()
      return
    }
    if (!plainKey(e)) return
    const target = e.target as HTMLElement
    if (e.key === 'Escape') {
      e.preventDefault()
      send(deny)
      return
    }
    if (target === message) {
      const text = message.value.trim()
      if (e.key === 'Enter' && text !== '') {
        e.preventDefault()
        send({ type: 'permission', choice: 'deny', suggestion: null, message: text })
      }
      return
    }
    if (target instanceof HTMLInputElement || e.key === 'Enter') return
    const n = Number(e.key)
    if (!card.defaultToNo && /^[1-9]$/.test(e.key) && choices[n - 1]) {
      e.preventDefault()
      choices[n - 1]!.click()
    }
  })
  return box
}

/** an edit's change: the path (a button that reveals it), the counts, and the removed and added lines */
function diffView(diff: { path: string; before: string; after: string }, reveal: (path: string) => void): HTMLElement {
  const box = el('div', 'chat-card-diff-view')
  const removed = linesOf(diff.before)
  const added = linesOf(diff.after)
  const head = el('div', 'chat-card-diff-head')
  const path = el('button', 'chat-card-path', diff.path) as HTMLButtonElement
  path.type = 'button'
  path.addEventListener('click', () => reveal(diff.path))
  head.append(path, el('span', 'chat-card-plus', `+${added.length}`), el('span', 'chat-card-minus', `−${removed.length}`))
  const lines = el('div', 'chat-card-diff')
  for (const text of removed) lines.append(diffLine('del', '−', text))
  for (const text of added) lines.append(diffLine('add', '+', text))
  box.append(head, lines)
  return box
}

function diffLine(kind: 'add' | 'del', sign: string, text: string): HTMLElement {
  const row = el('div', `chat-diff-line ${kind}`)
  row.append(el('span', 'chat-diff-sign', sign), el('span', 'chat-diff-text', text))
  return row
}

type PlanCard = Extract<ChatCard, { type: 'plan' }>

/**
 * The plan card: the plan as Markdown in a box that scrolls when long; Approve and accept edits, Approve and ask before edits,
 * Keep planning; a box that keeps planning with its text (Enter).
 */
function planCard(card: PlanCard, send: Send, cb: CardCallbacks): HTMLElement {
  const box = el('div', 'chat-card chat-card-plan')
  // the plan's Markdown is styled as a message's text, and its clicks behave as one's
  const text = el('div', 'chat-card-plan-text chat-text')
  text.innerHTML = chatMarkdownHtml(card.plan)
  text.addEventListener('click', (e) => markdownClick(e, cb))
  box.append(text)

  const actions = el('div', 'chat-card-actions')
  const accept = button('Approve and accept edits', 'primary', null)
  accept.dataset.start = ''
  accept.addEventListener('click', () => send({ type: 'plan', choice: 'accept-edits', message: null }))
  const ask = button('Approve and ask before edits', 'chat-card-ghost', null)
  ask.addEventListener('click', () => send({ type: 'plan', choice: 'ask-edits', message: null }))
  const keep = button('Keep planning', 'chat-card-ghost', null)
  keep.addEventListener('click', () => send({ type: 'plan', choice: 'keep-planning', message: null }))
  actions.append(accept, ask, keep)
  box.append(actions)

  const change = document.createElement('input')
  change.type = 'text'
  change.className = 'chat-card-message'
  change.placeholder = 'Tell Claude what to change…'
  box.append(change)

  box.addEventListener('keydown', (e) => {
    if (heldPress(e)) {
      e.preventDefault()
      return
    }
    if (!plainKey(e)) return
    const text = change.value.trim()
    if (e.target === change && e.key === 'Enter' && text !== '') {
      e.preventDefault()
      send({ type: 'plan', choice: 'keep-planning', message: text })
    }
  })
  return box
}
