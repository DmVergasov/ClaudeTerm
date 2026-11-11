import { WORKTREE_COLORS } from '../shared/types'
import { formatBadge } from './badge'
import { icon } from './icons'
import { shortcutLabel } from './keymap'
import { noteIcon } from './note-overlay'
import { beginRename, shownActivity, tabIcon } from './tab-row'
import type { TabBarCallbacks, TabBarItem } from './tabbar'
import { folderName } from './util'

/** what the header's left part shows of the active tab: while it is the same, the part is not built again */
function signature(item: TabBarItem | null, deviceColor: string | undefined): string {
  if (!item) return ''
  const worktree = item.place?.worktree ? WORKTREE_COLORS[item.place.worktree.color] : null
  return JSON.stringify([item.id, item.title, item.kind, shownActivity(item), item.folder, item.group, item.deviceName, item.dim, item.place?.branch ?? null, worktree, deviceColor ?? null])
}

export type SheetHeaderCallbacks = Pick<TabBarCallbacks, 'rename' | 'toggleImages' | 'toggleChanges' | 'toggleDocs' | 'toggleMessages' | 'toggleNote'>

/**
 * The header of the sheet the active tab sits on: its kind icon, title, device (a remote tab), branch and folder on the
 * left; then the panel toggles (Changes, Media, Agent messages, Docs, Note). The toggles are built once and kept in place, so
 * a redraw of the title never drops a click or a tooltip. While Claude works in the tab, the header's line runs.
 */
export class SheetHeader {
  private readonly changes: HTMLButtonElement
  private readonly images: HTMLButtonElement
  private readonly messages: HTMLButtonElement
  private readonly docs: HTMLButtonElement
  private readonly note: HTMLButtonElement
  private readonly spacer = document.createElement('div')
  private readonly modes = document.createElement('div')
  private readonly sweep = document.createElement('div')
  /** the elements of the active tab's part of the header, drawn again on each render */
  private left: HTMLElement[] = []
  private item: TabBarItem | null = null
  private deviceColor: string | undefined
  /** a title is being renamed: the header is not drawn again until it is done */
  private editing = false
  /** the signature of what the left part shows; '' before the first draw */
  private key = ''
  /** the tab and the count each badge last showed: a count that rises for the same tab pops its badge, a switch of tabs does not */
  private readonly counts = new Map<HTMLElement, { tab: string | null; n: number }>()

  constructor(private readonly root: HTMLElement, private readonly cb: SheetHeaderCallbacks, platform: string) {
    this.spacer.className = 'sh-spacer'
    this.modes.className = 'sh-modes'
    this.sweep.className = 'sh-sweep'
    this.sweep.setAttribute('aria-hidden', 'true')
    this.changes = this.toggle('tab-changes-toggle', 'Changes', `Changes (${shortcutLabel('toggleChanges', platform)})`, icon('file-diff', 16), () => cb.toggleChanges(), true)
    this.images = this.toggle('tab-images-toggle', 'Media', `Media (${shortcutLabel('toggleImages', platform)})`, icon('image', 16), () => cb.toggleImages(), true)
    this.messages = this.toggle('tab-messages-toggle', '', 'Agent messages', icon('mail', 16), () => cb.toggleMessages(), true)
    this.docs = this.toggle('tab-docs-toggle', '', `Docs (${shortcutLabel('toggleDocs', platform)})`, icon('file-text', 16), () => cb.toggleDocs(), false)
    this.note = this.toggle('tab-note-toggle', '', `Note (${shortcutLabel('toggleNote', platform)})`, noteIcon(16), () => cb.toggleNote(), false)
    this.root.replaceChildren(this.spacer, this.modes, this.changes, this.images, this.messages, this.docs, this.note, this.sweep)
    this.setChanges(false, false, 0, null)
    this.setImages(false, 0, null)
    this.setMessages(false, false, 0, null)
    this.setDocs(false, false)
    this.setNote(false, false)
  }

  /** the active tab; null: no tab. `deviceColor`: the color of a remote tab's device */
  render(item: TabBarItem | null, deviceColor?: string): void {
    this.item = item
    this.deviceColor = deviceColor
    this.root.classList.toggle('working', item !== null && shownActivity(item) === 'working')
    // a redraw that changes nothing visible keeps the title's element: a double click on the title must not straddle a rebuild
    const key = signature(item, deviceColor)
    if (this.editing || key === this.key) return
    this.key = key
    this.drawLeft()
  }

  /** the Changes button exists only for Claude tabs; it shows the files of `tab` not yet viewed */
  setChanges(available: boolean, visible: boolean, unviewed: number, tab: string | null): void {
    this.changes.hidden = !available
    this.changes.classList.toggle('active', visible)
    this.setBadge(this.changes, unviewed, tab)
  }

  /** the Media button is lit while the Media panel is shown, and counts the images of `tab` not yet seen */
  setImages(visible: boolean, unseen: number, tab: string | null): void {
    this.images.classList.toggle('active', visible)
    this.setBadge(this.images, unseen, tab)
  }

  /** the Messages button exists while agent messages are on; it is lit while the Agent messages panel is shown, and counts the unread messages of `tab` */
  setMessages(available: boolean, visible: boolean, unread: number, tab: string | null): void {
    this.messages.hidden = !available
    this.messages.classList.toggle('active', visible)
    this.setBadge(this.messages, unread, tab)
  }

  /** the Docs button is hidden while the tab has no document to show; it is lit while the Docs panel is shown */
  setDocs(available: boolean, visible: boolean): void {
    this.docs.hidden = !available
    this.docs.classList.toggle('active', visible)
  }

  /** the Note button exists only for Claude tabs; it is lit while the note is shown */
  setNote(available: boolean, visible: boolean): void {
    this.note.hidden = !available
    this.note.classList.toggle('active', visible)
  }

  private toggle(cls: string, label: string, title: string, iconHtml: string, onClick: () => void, badge: boolean): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = cls
    b.title = title
    b.innerHTML = iconHtml + (label === '' ? '' : `<span class="sh-label">${label}</span>`)
    if (badge) {
      const span = document.createElement('span')
      span.className = 'badge'
      // the pop is over when its animation ends: the class goes, and the next rise adds it again
      span.addEventListener('animationend', () => span.classList.remove('pop'))
      b.append(span)
    }
    b.addEventListener('click', onClick)
    return b
  }

  /** the active tab's part of the header: its icon, its title, its device, its branch and its folder */
  private drawLeft(): void {
    const parts: HTMLElement[] = []
    const item = this.item
    if (item) {
      // while the tab works, the header keeps a static glyph: the sweep line under the header already says so, and a second spinner would
      // step its glyph here too
      const kind = tabIcon({ ...item, activity: null })
      kind.classList.add('sh-icon')
      const title = document.createElement('span')
      title.className = 'sh-title'
      title.textContent = item.title
      title.title = item.title
      title.addEventListener('dblclick', () => this.startRename(title, item))
      parts.push(kind, title)
      if (item.group !== null && item.deviceName !== null) {
        const device = document.createElement('span')
        device.className = `sh-device${item.dim ? ' dim' : ''}`
        device.style.setProperty('--group-color', this.deviceColor ?? '')
        device.textContent = item.deviceName
        parts.push(device)
      }
      if (item.place) {
        const branch = document.createElement('div')
        branch.className = 'sh-branch'
        branch.innerHTML = icon('branch', 12)
        const text = document.createElement('span')
        text.textContent = item.place.branch
        branch.append(text)
        if (item.place.worktree) branch.style.color = WORKTREE_COLORS[item.place.worktree.color]
        parts.push(branch)
      }
      // the folder is named only when the title is not its name already (as the window's title does)
      if (folderName(item.folder) !== item.title) {
        const folder = document.createElement('span')
        folder.className = 'sh-folder'
        folder.textContent = folderName(item.folder)
        folder.title = item.folder
        parts.push(folder)
      }
    }
    for (const el of this.left) el.remove()
    this.left = parts
    this.root.prepend(...parts)
  }

  private startRename(label: HTMLElement, item: TabBarItem): void {
    this.editing = true
    beginRename(label, item.title, (title) => this.cb.rename(item.id, title), () => {
      // the input took the title's place: it goes before the header is drawn again
      this.root.querySelector('.tab-rename')?.remove()
      this.editing = false
      // the part is drawn again: its signature is not the one it was drawn with
      this.key = ''
      this.render(this.item, this.deviceColor)
    })
  }

  /** the count of `tab` on the badge; a count that rises for the same tab pops it, a count of another tab does not */
  private setBadge(b: HTMLElement, n: number, tab: string | null): void {
    const badge = b.querySelector<HTMLElement>('.badge')!
    const last = this.counts.get(badge)
    const rose = last !== undefined && last.tab === tab && n > last.n
    this.counts.set(badge, { tab, n })
    const text = formatBadge(n)
    badge.textContent = text
    badge.hidden = text === ''
    // a hidden badge's pop is over: showing it again later must not replay the pop the class still names
    if (badge.hidden) badge.classList.remove('pop')
    if (!rose) return
    // a pop still running starts again: the class goes, the reflow restarts the animation, and the class comes back
    badge.classList.remove('pop')
    void badge.offsetWidth
    badge.classList.add('pop')
  }
}
