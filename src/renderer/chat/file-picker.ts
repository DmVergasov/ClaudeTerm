export interface FilePickerOptions {
  /** the project's files whose path matches the query, best first */
  files(query: string): Promise<string[]>
  /** the file the user picked: the composer inserts it as a mention */
  pick(path: string): void
}

/**
 * The @ picker above the composer: the project's files that match the word typed after the @. ↑↓ move, Enter or Tab picks,
 * Esc closes. The answer of an older query is dropped when a newer one has been asked.
 */
export class FilePicker {
  readonly element: HTMLDivElement
  private shown: string[] = []
  private selected = 0
  private opened = false
  /** the query asked for last: an answer to an older one is dropped */
  private asked = 0
  /** the answer to the query asked for last is still on its way */
  private loading = false

  constructor(private readonly o: FilePickerOptions) {
    this.element = document.createElement('div')
    this.element.className = 'chat-file-picker'
    this.element.hidden = true
    this.element.setAttribute('role', 'listbox')
    this.element.setAttribute('aria-label', 'Project files')
  }

  get isOpen(): boolean {
    return this.opened
  }

  /** shows the picker over the anchor's field, for the query */
  open(anchor: HTMLElement, query: string): void {
    const host = anchor.closest<HTMLElement>('.chat-field') ?? anchor
    if (this.element.parentElement !== host) host.append(this.element)
    this.opened = true
    // the rows of an earlier opening are not this one's: the list is empty until its answer comes
    this.shown = []
    this.selected = 0
    this.element.hidden = false
    this.update(query)
  }

  /** the files for the query, as typed after the @; until the answer comes the rows are the older query's, and Enter waits */
  update(query: string): void {
    const id = ++this.asked
    this.loading = true
    this.render(query)
    void this.o.files(query).then((list) => {
      if (id !== this.asked || !this.opened) return
      this.loading = false
      this.shown = list
      this.selected = 0
      this.render(query)
    }, () => {
      if (id !== this.asked || !this.opened) return
      this.loading = false
      this.shown = []
      this.render(query)
    })
  }

  close(): void {
    this.opened = false
    this.loading = false
    this.element.hidden = true
    // an answer still on its way is for a picker that is gone
    this.asked++
  }

  /** the keys of the open picker; true when it took the key */
  key(e: KeyboardEvent): boolean {
    if (!this.opened) return false
    if (e.key === 'Escape') {
      this.close()
      return true
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (this.shown.length === 0) return false
      this.selected = (this.selected + (e.key === 'ArrowDown' ? 1 : -1) + this.shown.length) % this.shown.length
      this.highlight()
      return true
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      // the list of the query is still on its way: the key waits for it, so the half-typed word is not sent
      if (this.loading) return true
      const path = this.shown[this.selected]
      // nothing to pick: the key goes on as it would without the picker
      if (path === undefined) {
        this.close()
        return false
      }
      this.close()
      this.o.pick(path)
      return true
    }
    return false
  }

  private render(query: string): void {
    const rows = this.shown.map((path, i) => {
      const row = document.createElement('div')
      row.className = `chat-file-row${i === this.selected ? ' selected' : ''}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === this.selected))
      row.textContent = path
      row.title = path
      row.addEventListener('mousedown', (e) => e.preventDefault())
      row.addEventListener('click', () => {
        this.close()
        this.o.pick(path)
      })
      return row
    })
    if (rows.length === 0) {
      const none = document.createElement('div')
      none.className = 'chat-file-none'
      none.textContent = this.loading ? 'Looking for files…' : `No files match "${query}"`
      rows.push(none)
    }
    this.element.replaceChildren(...rows)
  }

  private highlight(): void {
    this.element.querySelectorAll('.chat-file-row').forEach((row, i) => {
      row.classList.toggle('selected', i === this.selected)
      row.setAttribute('aria-selected', String(i === this.selected))
    })
    this.element.querySelector('.chat-file-row.selected')?.scrollIntoView({ block: 'nearest' })
  }
}
