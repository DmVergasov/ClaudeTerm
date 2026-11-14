export { quoteMarkdown, splitQuotes } from '../../shared/quote-markdown'

/** the most quotes one message carries: the Quote button does not show while the composer holds this many */
export const MAX_QUOTES = 5

/** the chat's Quote button hangs this far from the selection's end */
const GAP = 6

/** the elements a selection in the conversation is not a quote of: the controls of a card and the fields */
const CONTROL = 'button, input, textarea, select, [contenteditable]'

function inControl(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest(CONTROL) != null
}

/**
 * The Quote button of one chat view. It shows above the end of a selection made in the conversation column (below it when
 * there is no room above), and hides when the selection collapses or leaves the column, when it scrolls out of the column, on Esc,
 * when the view is hidden, and after a click. While it stays in view the button follows it as the column scrolls. Its press keeps the selection, so the release copies nothing new.
 */
export class QuoteButton {
  readonly element: HTMLButtonElement
  /** the text the button quotes: the selection as it was when the button showed */
  private text = ''
  private shown = false
  /** the mouse is held in the column: the selection is still moving, so the button waits for the release */
  private pressed = false
  /** the view is in front: a hidden chat shows no button */
  private active = false

  constructor(private readonly o: {
    host: HTMLElement
    column: HTMLElement
    scroll: HTMLElement
    canQuote(): boolean
    quote(text: string): void
  }) {
    this.element = document.createElement('button')
    this.element.type = 'button'
    this.element.className = 'chat-quote-button'
    this.element.textContent = 'Quote'
    this.element.setAttribute('aria-label', 'Quote the selection')
    this.element.hidden = true
    // a press keeps the selection: the button does not take the focus or move the selection, so nothing is copied again
    this.element.addEventListener('mousedown', (e) => e.preventDefault())
    this.element.addEventListener('click', () => this.quote())
    o.column.addEventListener('mousedown', () => { this.pressed = true })
    document.addEventListener('mouseup', this.onMouseUp)
    document.addEventListener('selectionchange', this.onSelection)
    document.addEventListener('keydown', this.onKey)
    o.scroll.addEventListener('scroll', this.onScroll)
    o.host.append(this.element)
  }

  /** the view is shown or hidden: a hidden view has no button, and a shown one takes the selection as it is */
  setActive(on: boolean): void {
    this.active = on
    if (on) this.sync()
    else this.hide()
  }

  dispose(): void {
    document.removeEventListener('mouseup', this.onMouseUp)
    document.removeEventListener('selectionchange', this.onSelection)
    document.removeEventListener('keydown', this.onKey)
    this.o.scroll.removeEventListener('scroll', this.onScroll)
    this.element.remove()
  }

  private readonly onSelection = (): void => this.sync()

  private readonly onMouseUp = (): void => {
    this.pressed = false
    this.sync()
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.hide()
  }

  // the column scrolls, or settles when the composer grows: the button follows the selection, and hides when it scrolls out
  private readonly onScroll = (): void => this.sync()

  /** the button shows for the selection in the column, or hides */
  private sync(): void {
    if (!this.active || this.pressed) return this.hide()
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return this.hide()
    const { anchorNode, focusNode } = selection
    if (!anchorNode || !focusNode || !this.o.column.contains(anchorNode) || !this.o.column.contains(focusNode)) return this.hide()
    if (inControl(anchorNode) || inControl(focusNode)) return this.hide()
    const text = selection.toString().trim()
    if (text === '' || !this.o.canQuote()) return this.hide()
    const ends = Array.from(selection.getRangeAt(0).getClientRects()).filter((r) => r.height > 0)
    const end = ends[ends.length - 1]
    if (end === undefined) return this.hide()
    // a selection scrolled out of the column has no place for its button
    const frame = this.o.scroll.getBoundingClientRect()
    if (end.bottom < frame.top || end.top > frame.bottom) return this.hide()
    this.text = text
    this.shown = true
    this.element.hidden = false
    const host = this.o.host.getBoundingClientRect()
    const width = this.element.offsetWidth
    const height = this.element.offsetHeight
    let top = end.top - host.top - height - GAP
    if (top < 0) top = end.bottom - host.top + GAP
    const left = Math.max(0, Math.min(end.right - host.left - width / 2, host.width - width))
    this.element.style.left = `${left}px`
    this.element.style.top = `${top}px`
  }

  private hide(): void {
    this.text = ''
    if (!this.shown) return
    this.shown = false
    this.element.hidden = true
  }

  private quote(): void {
    const text = this.text
    this.hide()
    if (text !== '') this.o.quote(text)
  }
}
