/** what the search bar drives: a terminal's SearchAddon, or a chat's ChatFind (SearchAddon satisfies it as it is) */
export interface FindTarget {
  findNext(term: string, opts?: { caseSensitive?: boolean; incremental?: boolean }): boolean
  findPrevious(term: string, opts?: { caseSensitive?: boolean }): boolean
  clearDecorations(): void
  /** a target that searches as the term is typed; the terminal's search waits for Enter, as it always did */
  readonly searchAsYouType?: boolean
}

/** the as-you-type search waits this long for the next key: typing does not search at every letter */
const TYPING_MS = 150

export class SearchBar {
  private readonly input: HTMLInputElement
  /** the as-you-type search that is waiting for the next key */
  private typing: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly root: HTMLElement, private readonly target: () => FindTarget | null, private readonly onClose: () => void) {
    this.input = document.createElement('input')
    this.input.placeholder = 'Find — Enter / Shift+Enter, Esc to close'
    root.replaceChildren(this.input)
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.close()
        return
      }
      if (e.key !== 'Enter') return
      e.preventDefault()
      // the as-you-type search of the term typed so far comes first: Enter then takes the match after it
      if (this.typing !== null) this.typedSearch()
      const t = this.target()
      if (!t || !this.input.value) return
      if (e.shiftKey) t.findPrevious(this.input.value)
      else t.findNext(this.input.value)
    })
    this.input.addEventListener('input', () => {
      if (this.typing !== null) clearTimeout(this.typing)
      this.typing = setTimeout(() => this.typedSearch(), TYPING_MS)
    })
  }

  /** the as-you-type search of the term as it is now: a target that searches as it is typed takes it */
  private typedSearch(): void {
    if (this.typing !== null) clearTimeout(this.typing)
    this.typing = null
    const t = this.target()
    if (!t?.searchAsYouType) return
    if (this.input.value === '') t.clearDecorations()
    else t.findNext(this.input.value, { incremental: true })
  }

  open(): void {
    this.root.hidden = false
    this.input.focus()
    this.input.select()
  }

  close(): void {
    this.cancelTyping()
    this.root.hidden = true
    this.target()?.clearDecorations()
    this.onClose()
  }

  private cancelTyping(): void {
    if (this.typing !== null) clearTimeout(this.typing)
    this.typing = null
  }
}
