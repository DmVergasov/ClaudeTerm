import type { TabKind } from '../shared/types'

export interface TabBarItem {
  id: string
  title: string
  kind: TabKind
  bell: boolean
  images: number
  exited: boolean
}

export interface TabBarCallbacks {
  activate(id: string): void
  close(id: string): void
  rename(id: string, title: string | null): void
  reorder(ids: string[]): void
  newTab(): void
  openMenu(anchor: HTMLElement): void
}

function button(text: string, cls: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = cls
  b.textContent = text
  b.title = title
  b.addEventListener('click', onClick)
  return b
}

export class TabBar {
  private editing: string | null = null
  private dragId: string | null = null
  private items: TabBarItem[] = []
  private activeId: string | null = null

  constructor(private readonly root: HTMLElement, private readonly cb: TabBarCallbacks) {}

  render(items: TabBarItem[], activeId: string | null): void {
    this.items = items
    this.activeId = activeId
    if (this.editing) return
    const list = document.createElement('div')
    list.className = 'tabs'
    for (const item of items) list.append(this.renderTab(item, item.id === activeId))
    const plus = button('+', 'tab-new', 'New tab (Ctrl+Shift+T)', () => this.cb.newTab())
    const more = button('▾', 'tab-menu', 'Profiles', (e) => this.cb.openMenu(e.currentTarget as HTMLElement))
    this.root.replaceChildren(list, plus, more)
  }

  private renderTab(item: TabBarItem, active: boolean): HTMLElement {
    const el = document.createElement('div')
    el.className = `tab${active ? ' active' : ''}${item.exited ? ' exited' : ''}`
    el.dataset.tabId = item.id
    el.draggable = true
    el.title = item.title
    const icon = document.createElement('span')
    icon.className = 'tab-icon'
    icon.textContent = item.kind === 'claude' ? '✳' : '>'
    const label = document.createElement('span')
    label.className = 'tab-title'
    label.textContent = item.title
    el.append(icon, label)
    if (item.bell) {
      const b = document.createElement('span')
      b.className = 'tab-bell'
      b.textContent = '●'
      el.append(b)
    }
    if (item.images > 0) {
      const b = document.createElement('span')
      b.className = 'tab-images'
      b.textContent = `🖼${item.images}`
      el.append(b)
    }
    el.append(button('×', 'tab-close', 'Close (Ctrl+Shift+W)', (e) => {
      e.stopPropagation()
      this.cb.close(item.id)
    }))
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        this.cb.close(item.id)
      }
    })
    el.addEventListener('click', () => this.cb.activate(item.id))
    el.addEventListener('dblclick', () => this.beginRename(label, item))
    el.addEventListener('dragstart', () => { this.dragId = item.id })
    el.addEventListener('dragover', (e) => { if (this.dragId) e.preventDefault() })
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      this.dropOn(item.id)
    })
    el.addEventListener('dragend', () => { this.dragId = null })
    return el
  }

  private dropOn(targetId: string): void {
    const from = this.dragId
    this.dragId = null
    if (!from || from === targetId) return
    const all = this.items.map((i) => i.id)
    const fromIdx = all.indexOf(from)
    const toIdx = all.indexOf(targetId)
    const ids = all.filter((id) => id !== from)
    const t = ids.indexOf(targetId)
    ids.splice(fromIdx < toIdx ? t + 1 : t, 0, from)
    this.cb.reorder(ids)
  }

  private beginRename(label: HTMLElement, item: TabBarItem): void {
    this.editing = item.id
    const input = document.createElement('input')
    input.className = 'tab-rename'
    input.value = item.title
    label.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      this.editing = null
      const value = input.value.trim()
      if (commit && value !== item.title) this.cb.rename(item.id, value === '' ? null : value)
      this.render(this.items, this.activeId)
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') finish(true)
      else if (e.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
  }
}
