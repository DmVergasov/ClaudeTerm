import type { ImageCard } from '../shared/types'
import { imageUrl } from './image-url'

export class Lightbox {
  private cards: ImageCard[] = []
  private index = 0
  private scale = 1
  private tx = 0
  private ty = 0
  private readonly img: HTMLImageElement
  private readonly caption: HTMLElement

  constructor(private readonly root: HTMLElement) {
    this.img = document.createElement('img')
    this.img.draggable = false
    this.caption = document.createElement('div')
    this.caption.className = 'lightbox-caption'
    root.replaceChildren(this.img, this.caption)
    root.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.scale = Math.min(Math.max(this.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.1), 20)
      this.apply()
    }, { passive: false })
    root.addEventListener('mousedown', (e) => {
      if (e.target !== this.img) {
        this.close()
        return
      }
      e.preventDefault()
      const sx = e.clientX - this.tx
      const sy = e.clientY - this.ty
      const move = (ev: MouseEvent): void => {
        this.tx = ev.clientX - sx
        this.ty = ev.clientY - sy
        this.apply()
      }
      const up = (): void => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
    // capture phase: handle Esc/arrows before the focused terminal sees them
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return
      if (e.key === 'Escape') this.close()
      else if (e.key === 'ArrowRight') this.go(1)
      else if (e.key === 'ArrowLeft') this.go(-1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }, true)
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  open(cards: ImageCard[], index: number): void {
    this.cards = cards
    this.index = index
    this.root.hidden = false
    this.load()
  }

  close(): void {
    this.root.hidden = true
    this.img.removeAttribute('src')
  }

  private go(delta: number): void {
    if (this.cards.length === 0) return
    this.index = (this.index + delta + this.cards.length) % this.cards.length
    this.load()
  }

  private load(): void {
    const c = this.cards[this.index]
    if (!c) return
    this.scale = 1
    this.tx = 0
    this.ty = 0
    this.img.src = imageUrl(c)
    this.caption.textContent = `${c.name}${c.caption ? ` — ${c.caption}` : ''}  (${this.index + 1}/${this.cards.length})`
    this.apply()
  }

  private apply(): void {
    this.img.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`
  }
}
