import type { RestoreInfo } from '../shared/ipc'

export function plural(n: number): string {
  return n === 1 ? 'tab' : 'tabs'
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export class RestoreBanner {
  private dismissed = false

  constructor(private readonly root: HTMLElement, private readonly onRestore: () => void) {}

  update(info: RestoreInfo | null): void {
    if (!info || this.dismissed) {
      this.root.hidden = true
      this.root.replaceChildren()
      return
    }
    const text = document.createElement('span')
    text.textContent = `Previous session: ${info.tabs} ${plural(info.tabs)} (${info.claudeTabs} Claude) · ${formatTime(info.savedAt)}`
    const go = document.createElement('button')
    go.className = 'banner-restore'
    go.textContent = 'Restore'
    go.addEventListener('click', () => this.onRestore())
    const close = document.createElement('button')
    close.className = 'banner-close'
    close.textContent = '×'
    close.title = 'Hide'
    close.addEventListener('click', () => {
      this.dismissed = true
      this.update(null)
    })
    this.root.replaceChildren(text, go, close)
    this.root.hidden = false
  }
}
