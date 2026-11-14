import type { HeadsUpAction, HeadsUpCard } from '../../shared/chat'
import { chatMarkdownHtml, markdownClick } from './chat-markdown'

export interface HeadsUpViewOptions {
  act(cardId: string, action: HeadsUpAction): void
  openExternal(url: string): void
  copy(text: string): void
  ask(cardId: string, text: string): Promise<string | null>
}

const TAGS: Record<HeadsUpCard['tag'], string> = { 'heads-up': 'Heads up', 'should-know': 'You should know' }

/**
 * The Heads up card above a chat's message box: its tag and title, the side agent's explanation, the longer one once Explain
 * more has brought it, the person's answers and their own message to Claude about the card. Hidden while the chat has no card.
 */
export class HeadsUpView {
  readonly element: HTMLElement
  private shown: HeadsUpCard | null = null
  // the card the field's text belongs to: a new card starts with an empty field
  private fieldCard: string | null = null
  private asking = false
  private readonly askRow: HTMLElement
  private readonly input: HTMLTextAreaElement
  private readonly askButton: HTMLButtonElement
  private readonly askError: HTMLElement

  constructor(private readonly o: HeadsUpViewOptions) {
    this.element = document.createElement('section')
    this.element.className = 'chat-heads-up'
    this.element.setAttribute('aria-label', 'Heads up')
    this.element.setAttribute('aria-live', 'polite')
    this.element.hidden = true
    // a link in the explanation opens in the browser, a code block's Copy copies, as in the conversation
    this.element.addEventListener('click', (e) => markdownClick(e, { openExternal: (url) => this.o.openExternal(url), copy: (text) => this.o.copy(text) }))

    // made once: show rebuilds the card's children, and the field keeps what the person typed across those rebuilds
    this.askRow = document.createElement('div')
    this.askRow.className = 'chat-heads-up-ask'
    this.input = document.createElement('textarea')
    this.input.className = 'chat-heads-up-input'
    this.input.rows = 1
    this.input.placeholder = 'Ask Claude about this…'
    this.input.setAttribute('aria-label', 'Ask Claude about this card')
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto'
      this.input.style.height = `${this.input.scrollHeight}px`
      this.updateAsk()
    })
    this.input.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter is a new line, and Enter while an IME composes a word is the IME's
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
      e.preventDefault()
      void this.send()
    })
    this.askButton = document.createElement('button')
    this.askButton.type = 'button'
    this.askButton.className = 'chat-heads-up-btn'
    this.askButton.dataset.action = 'ask'
    this.askButton.textContent = 'Ask Claude'
    this.askButton.addEventListener('click', () => void this.send())
    this.askError = document.createElement('div')
    this.askError.className = 'chat-heads-up-error'
    this.askError.hidden = true
    this.askRow.append(this.input, this.askButton, this.askError)
    this.updateAsk()
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
    if (card.id !== this.fieldCard) {
      this.fieldCard = card.id
      this.input.value = ''
      this.input.style.height = ''
      this.setAskError(null)
      this.updateAsk()
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
    parts.push(this.askRow)

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

  /** the person's message about the shown card goes to the chat; main closes the card once it is sent */
  private async send(): Promise<void> {
    const card = this.shown
    const text = this.input.value.trim()
    if (card === null || text === '' || this.asking) return
    this.asking = true
    this.updateAsk()
    this.setAskError(null)
    try {
      const error = await this.o.ask(card.id, text)
      // the field may have moved on to another card while the message went: then it is not this card's text any more
      if (this.fieldCard !== card.id) return
      if (error === null) {
        this.input.value = ''
        this.input.style.height = ''
      } else {
        this.setAskError(error)
      }
    } finally {
      this.asking = false
      this.updateAsk()
    }
  }

  private updateAsk(): void {
    this.askButton.disabled = this.asking || this.input.value.trim() === ''
  }

  private setAskError(text: string | null): void {
    this.askError.textContent = text ?? ''
    this.askError.hidden = text === null
  }
}
