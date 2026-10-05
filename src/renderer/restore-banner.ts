import type { RestoreInfo } from '../shared/ipc'

export function plural(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'вкладка'
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'вкладки'
  return 'вкладок'
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
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
    text.textContent = `Предыдущая сессия: ${info.tabs} ${plural(info.tabs)} (${info.claudeTabs} Claude) · ${formatTime(info.savedAt)}`
    const go = document.createElement('button')
    go.className = 'banner-restore'
    go.textContent = 'Продолжить'
    go.addEventListener('click', () => this.onRestore())
    const close = document.createElement('button')
    close.className = 'banner-close'
    close.textContent = '×'
    close.title = 'Скрыть'
    close.addEventListener('click', () => {
      this.dismissed = true
      this.update(null)
    })
    this.root.replaceChildren(text, go, close)
    this.root.hidden = false
  }
}
