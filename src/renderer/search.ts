import type { SearchAddon } from '@xterm/addon-search'

export class SearchBar {
  private readonly input: HTMLInputElement

  constructor(private readonly root: HTMLElement, private readonly addon: () => SearchAddon | null, private readonly onClose: () => void) {
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
      const a = this.addon()
      if (!a || !this.input.value) return
      if (e.shiftKey) a.findPrevious(this.input.value)
      else a.findNext(this.input.value)
    })
  }

  open(): void {
    this.root.hidden = false
    this.input.focus()
    this.input.select()
  }

  close(): void {
    this.root.hidden = true
    this.addon()?.clearDecorations()
    this.onClose()
  }
}
