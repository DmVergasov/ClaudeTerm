import type { ImageAction, ImagesUpdate } from '../shared/ipc'
import type { ImageCard, ImageSource } from '../shared/types'
import { imageUrl } from './image-url'
import { showMenu } from './menu'
import type { SidePanel } from './side-panel'

export interface ImagePanelCallbacks {
  action(cardId: string, action: ImageAction): void
  insertPath(path: string): void
  open(cards: ImageCard[], index: number): void
  markSeen(tabId: string): void
}

const SOURCE_LABEL: Record<ImageSource, string> = { created: 'created', shown: 'show_image', read: 'read', tool: 'tool', pasted: 'you' }

export class ImagePanel {
  private current: ImagesUpdate | null = null
  private readonly autoOpened = new Set<string>()
  private readonly list: HTMLElement
  private readonly noticeEl: HTMLElement

  constructor(root: HTMLElement, private readonly panel: SidePanel, private readonly cb: ImagePanelCallbacks, private readonly autoOpen: () => boolean) {
    this.noticeEl = document.createElement('div')
    this.noticeEl.className = 'panel-notice'
    this.list = document.createElement('div')
    this.list.className = 'panel-list'
    root.replaceChildren(this.noticeEl, this.list)
  }

  /** Images is shown */
  get visible(): boolean {
    return this.panel.isShowing('images')
  }

  toggle(): void {
    this.panel.toggle('images')
  }

  /** the side panel was shown, hidden or switched */
  panelChanged(): void {
    if (this.visible && this.current && this.current.unseen > 0) this.cb.markSeen(this.current.tabId)
  }

  show(update: ImagesUpdate): void {
    this.current = update
    // a new image opens the panel only when it is closed: it never takes the place of Changes
    if (update.cards.length > 0 && !this.panel.visible && this.autoOpen() && !this.autoOpened.has(update.tabId)) {
      this.autoOpened.add(update.tabId)
      this.panel.open('images')
    }
    this.renderList()
    if (this.visible && update.unseen > 0) this.cb.markSeen(update.tabId)
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
}
