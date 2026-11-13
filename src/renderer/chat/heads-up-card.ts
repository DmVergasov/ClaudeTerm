import type { HeadsUpAction, HeadsUpCard } from '../../shared/chat'
import { chatMarkdownHtml, markdownClick } from './chat-markdown'

export interface HeadsUpViewOptions {
  act(cardId: string, action: HeadsUpAction): void
  openExternal(url: string): void
  copy(text: string): void
}

const TAGS: Record<HeadsUpCard['tag'], string> = { 'heads-up': 'Heads up', 'should-know': 'You should know' }

/**
 * The Heads up card above a chat's message box: its tag and title, the side agent's explanation, the longer one once Explain
 * more has brought it, and the person's answers. Hidden while the chat has no card.
 */
export class HeadsUpView {
  readonly element: HTMLElement
  private shown: HeadsUpCard | null = null

  constructor(private readonly o: HeadsUpViewOptions) {
    this.element = document.createElement('section')
    this.element.className = 'chat-heads-up'
    this.element.setAttribute('aria-label', 'Heads up')
    this.element.setAttribute('aria-live', 'polite')
    this.element.hidden = true
    // a link in the explanation opens in the browser, a code block's Copy copies, as in the conversation
    this.element.addEventListener('click', (e) => markdownClick(e, { openExternal: (url) => this.o.openExternal(url), copy: (text) => this.o.copy(text) }))
  }

  /** the chat's card now; null takes it away */
  show(card: HeadsUpCard | null): void {
    const same = this.shown !== null && card !== null && JSON.stringify(this.shown) === JSON.stringify(card)
    this.shown = card
    if (same) return
    this.element.hidden = card === null
    if (card === null) {
      this.element.replaceChildren()
      return
    }
    this.element.dataset.tag = card.tag

    const head = document.createElement('div')
    head.className = 'chat-heads-up-head'
    const tag = document.createElement('span')
    tag.className = 'chat-heads-up-tag'
    tag.textContent = TAGS[card.tag]
    const title = document.createElement('span')
    title.className = 'chat-heads-up-title'
    title.textContent = card.title
    head.append(tag, title)

    const text = document.createElement('div')
    text.className = 'chat-text chat-heads-up-text'
    text.innerHTML = chatMarkdownHtml(card.text)
    const parts: HTMLElement[] = [head, text]
    if (card.more !== null) {
      const more = document.createElement('div')
      more.className = 'chat-text chat-heads-up-more'
      more.innerHTML = chatMarkdownHtml(card.more)
      parts.push(more)
    }
    if (card.explainError !== null) {
      const error = document.createElement('div')
      error.className = 'chat-heads-up-error'
      error.textContent = card.explainError
      parts.push(error)
    }

    const actions = document.createElement('div')
    actions.className = 'chat-heads-up-actions'
    const button = (action: HeadsUpAction, label: string, primary = false): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `chat-heads-up-btn${primary ? ' primary' : ''}`
      b.dataset.action = action
      b.textContent = label
      b.addEventListener('click', () => this.o.act(card.id, action))
      return b
    }
    if (card.more === null) {
      const explain = button('explain', card.explaining ? 'Explaining…' : 'Explain more')
      explain.disabled = card.explaining
      actions.append(explain)
    }
    actions.append(button('not-relevant', 'Not relevant'), button('got-it', 'Got it', true))
    parts.push(actions)
    this.element.replaceChildren(...parts)
  }
}
