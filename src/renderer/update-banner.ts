import type { ReleaseNotes, UpdateState } from '../shared/types'

/** "A new version is ready" under the tab bar, with what changed behind What's new; × hides it for that version only. */
export class UpdateBanner {
  private dismissed: string | null = null
  private last: UpdateState = { status: 'idle' }
  /** the open What's new list and its button */
  private open: { list: HTMLElement; button: HTMLElement } | null = null

  constructor(private readonly root: HTMLElement, private readonly onInstall: () => void) {
    // capture phase: the Esc that closes the list must not reach the terminal, where it would interrupt Claude
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.open) return
      e.preventDefault()
      e.stopPropagation()
      this.closeNotes()
    }, true)
    // a click anywhere else closes it, and still does what it does there
    document.addEventListener('mousedown', (e) => {
      const t = e.target as Node
      if (this.open && !this.open.list.contains(t) && !this.open.button.contains(t)) this.closeNotes()
    }, true)
  }

  update(state: UpdateState): void {
    this.last = state
    this.open = null
    if (state.status !== 'ready' || state.version === this.dismissed) {
      this.root.hidden = true
      this.root.replaceChildren()
      return
    }
    const version = state.version
    const text = document.createElement('span')
    text.textContent = `ClaudeTerm ${version} is ready to install.`
    const go = document.createElement('button')
    go.className = 'banner-restart'
    go.textContent = 'Restart'
    go.addEventListener('click', () => this.onInstall())
    const close = document.createElement('button')
    close.className = 'banner-close'
    close.textContent = '×'
    close.title = 'Hide'
    close.addEventListener('click', () => {
      this.dismissed = version
      this.open = null
      this.root.hidden = true
      this.root.replaceChildren()
    })
    if (state.notes.length === 0) {
      this.root.replaceChildren(text, go, close)
    } else {
      const list = notesList(state.notes)
      const notes = document.createElement('button')
      notes.className = 'banner-notes'
      notes.textContent = "What's new ▾"
      notes.addEventListener('click', () => {
        if (this.open) this.closeNotes()
        else {
          list.hidden = false
          this.open = { list, button: notes }
        }
      })
      this.root.replaceChildren(text, notes, go, close, list)
    }
    this.root.hidden = false
  }

  /** The user asked about updates: show a downloaded update again even if its banner was dismissed. */
  reveal(): void {
    this.dismissed = null
    this.update(this.last)
  }

  private closeNotes(): void {
    if (this.open) this.open.list.hidden = true
    this.open = null
  }
}

/** each item's headline, its whole text in the tooltip; a version heading only when there are several */
function notesList(notes: ReleaseNotes[]): HTMLElement {
  const list = document.createElement('div')
  list.className = 'update-notes'
  list.hidden = true
  for (const n of notes) {
    if (notes.length > 1) {
      const head = document.createElement('div')
      head.className = 'update-notes-version'
      head.textContent = n.version
      list.append(head)
    }
    const ul = document.createElement('ul')
    for (const item of n.items) {
      const li = document.createElement('li')
      li.textContent = item.title
      li.title = item.text
      ul.append(li)
    }
    list.append(ul)
  }
  return list
}
