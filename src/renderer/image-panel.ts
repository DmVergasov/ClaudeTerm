import type { ImageAction, ImagesUpdate } from '../shared/ipc'
import type { ImageCard, ImageSource } from '../shared/types'
import { imageUrl } from './image-url'
import { showMenu } from './menu'

export interface ImagePanelCallbacks {
  action(cardId: string, action: ImageAction): void
  insertPath(path: string): void
  open(cards: ImageCard[], index: number): void
  markSeen(tabId: string): void
}

const SOURCE_LABEL: Record<ImageSource, string> = { created: 'created', shown: 'show_image', read: 'read', tool: 'tool', pasted: 'you' }

export class ImagePanel {
  private collapsed = true
  private current: ImagesUpdate | null = null
  private readonly autoOpened = new Set<string>()
  private readonly list: HTMLElement
  private readonly noticeEl: HTMLElement
  onVisibilityChange: () => void = () => {}

  constructor(private readonly root: HTMLElement, private readonly cb: ImagePanelCallbacks, private width: number, private readonly autoOpen: () => boolean) {
    const handle = document.createElement('div')
    handle.className = 'panel-resize'
    const header = document.createElement('div')
    header.className = 'panel-header'
    const title = document.createElement('span')
    title.textContent = 'Images'
    const hide = document.createElement('button')
    hide.textContent = '–'
    hide.title = 'Hide (Ctrl+Shift+I)'
    hide.addEventListener('click', () => this.setCollapsed(true))
    header.append(title, hide)
    this.noticeEl = document.createElement('div')
    this.noticeEl.className = 'panel-notice'
    this.list = document.createElement('div')
    this.list.className = 'panel-list'
    root.replaceChildren(handle, header, this.noticeEl, this.list)
    this.setupResize(handle)
    this.root.style.width = `${this.width}px`
    this.setCollapsed(true)
  }

  get visible(): boolean {
    return !this.collapsed
  }

  toggle(): void {
    this.setCollapsed(!this.collapsed)
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed
    this.root.classList.toggle('collapsed', collapsed)
    this.onVisibilityChange()
    if (!collapsed && this.current && this.current.unseen > 0) this.cb.markSeen(this.current.tabId)
  }

  show(update: ImagesUpdate): void {
    this.current = update
    if (update.cards.length > 0 && this.collapsed && this.autoOpen() && !this.autoOpened.has(update.tabId)) {
      this.autoOpened.add(update.tabId)
      this.setCollapsed(false)
    }
    this.renderList()
    if (!this.collapsed && update.unseen > 0) this.cb.markSeen(update.tabId)
  }

  private renderList(): void {
    const u = this.current
    this.noticeEl.textContent = u?.notice ?? ''
    this.noticeEl.hidden = !u?.notice
    if (!u || u.cards.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'panel-empty'
      empty.textContent = 'No images yet'
      this.list.replaceChildren(empty)
      return
    }
    this.list.replaceChildren(...u.cards.map((card, index) => this.renderCard(card, index, u.cards)))
  }

  private renderCard(card: ImageCard, index: number, all: ImageCard[]): HTMLElement {
    const el = document.createElement('div')
    el.className = `card${card.deleted ? ' deleted' : ''}`
    el.dataset.cardId = card.id
    const img = document.createElement('img')
    img.src = imageUrl(card)
    img.alt = card.name
    img.draggable = false
    const meta = document.createElement('div')
    meta.className = 'card-meta'
    const name = document.createElement('div')
    name.className = 'card-name'
    name.textContent = card.name
    name.title = card.path
    const tags = [new Date(card.touchedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), SOURCE_LABEL[card.source]]
    if (card.updated) tags.push('updated')
    if (card.deleted) tags.push('deleted')
    const sub = document.createElement('div')
    sub.className = 'card-sub'
    sub.textContent = `${card.relPath} · ${tags.join(' · ')}`
    meta.append(name, sub)
    if (card.caption) {
      const cap = document.createElement('div')
      cap.className = 'card-caption'
      cap.textContent = card.caption
      meta.append(cap)
    }
    el.append(img, meta)
    el.addEventListener('click', () => this.cb.open(all, index))
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showMenu({ x: e.clientX, y: e.clientY }, [
        { label: 'Open in viewer', action: () => this.cb.action(card.id, 'open') },
        { label: 'Show in Explorer', action: () => this.cb.action(card.id, 'reveal') },
        { label: 'Copy image', action: () => this.cb.action(card.id, 'copy-image') },
        { label: 'Copy path', action: () => this.cb.action(card.id, 'copy-path') },
        { label: 'Insert path into terminal', action: () => this.cb.insertPath(card.path) },
        { label: '', separator: true },
        { label: 'Remove from panel', action: () => this.cb.action(card.id, 'remove') }
      ])
    })
    return el
  }

  private setupResize(handle: HTMLElement): void {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = this.width
      const move = (ev: MouseEvent): void => {
        this.width = Math.min(Math.max(startW + (startX - ev.clientX), 180), Math.round(window.innerWidth * 0.7))
        this.root.style.width = `${this.width}px`
      }
      const up = (): void => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
  }
}
