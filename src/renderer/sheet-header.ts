import type { TabView } from '../shared/chat'
import { WORKTREE_COLORS } from '../shared/types'
import { formatBadge } from './badge'
import { icon, type IconName } from './icons'
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

export type SheetHeaderCallbacks = Pick<TabBarCallbacks, 'rename' | 'toggleImages' | 'toggleChanges' | 'toggleDocs' | 'toggleMessages' | 'toggleNote'> & {
  /** the Chat | Terminal switch: the tab in front shows the other view (after the user's word when background tasks would stop) */
  switchView(view: TabView): void
  /** files dropped on the header: attached to the chat in front, as a drop on the sheet is */
  drop(files: File[]): void
}

/** the Chat | Terminal switch of the tab in front: the tab, its view, whether Claude works in it, and its background tasks still running */
export interface SheetModes { tab: string; view: TabView; busy: boolean; background: number }

/** the question a switch asks when background tasks would stop, and the button that answers it yes */
export interface SwitchAsk { question: string; action: string }
const SWITCH_ASK: SwitchAsk = { question: 'Switch anyway?', action: 'Switch' }

const WORKING_SWITCH = 'Claude is working — switch when it finishes, or press Esc to stop it'

/**
 * The header of the sheet the active tab sits on: its kind icon, title, device (a remote tab), branch and folder on the
 * left; then the panel toggles (Changes, Media, Agent messages, Docs, Note). The toggles are built once and kept in place, so
 * a redraw of the title never drops a click or a tooltip. While Claude works in the tab, the header's glyph steps.
 */
export class SheetHeader {
  private readonly changes: HTMLButtonElement
  private readonly images: HTMLButtonElement
  private readonly messages: HTMLButtonElement
  private readonly docs: HTMLButtonElement
  private readonly note: HTMLButtonElement
  private readonly spacer = document.createElement('div')
  private readonly modes = document.createElement('div')
  private readonly chatMode: HTMLButtonElement
  private readonly terminalMode: HTMLButtonElement
  /** the row under the switch that asks before a switch stops background tasks */
  private readonly confirm = document.createElement('div')
  private readonly confirmText = document.createElement('span')
  /** the tab in front, the view it shows, whether Claude works in it, its background tasks, and the switch that waits for the user's word */
  private tab: string | null = null
  private view: TabView | null = null
  private busy = false
  private background = 0
  /**
   * A switch the question is about: what runs on Switch, what on Cancel, the tab and the view it was asked from, the count of its
   * background tasks and the words the question uses. The question is the tab's: another tab in front drops it.
   */
  private pending: { tab: string; go: () => void; cancel: () => void; from: TabView | null; count: number; ask: SwitchAsk } | null = null
  private readonly switchButton: HTMLButtonElement
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
    this.chatMode = this.modeButton('chat', 'Chat', 'message-square')
    this.terminalMode = this.modeButton('terminal', 'Terminal', 'terminal')
    this.confirm.className = 'sh-mode-confirm'
    this.confirm.hidden = true
    this.switchButton = this.confirmButton('Switch', () => this.confirmSwitch())
    this.confirm.append(this.confirmText, this.switchButton, this.confirmButton('Cancel', () => this.cancelSwitch()))
    this.modes.hidden = true
    this.modes.append(this.chatMode, this.terminalMode, this.confirm)
    this.changes = this.toggle('tab-changes-toggle', 'Changes', `Changes (${shortcutLabel('toggleChanges', platform)})`, icon('file-diff', 16), () => cb.toggleChanges(), true)
    this.images = this.toggle('tab-images-toggle', 'Media', `Media (${shortcutLabel('toggleImages', platform)})`, icon('image', 16), () => cb.toggleImages(), true)
    this.messages = this.toggle('tab-messages-toggle', '', 'Agent messages', icon('mail', 16), () => cb.toggleMessages(), true)
    this.docs = this.toggle('tab-docs-toggle', '', `Docs (${shortcutLabel('toggleDocs', platform)})`, icon('file-text', 16), () => cb.toggleDocs(), false)
    this.note = this.toggle('tab-note-toggle', '', `Note (${shortcutLabel('toggleNote', platform)})`, noteIcon(16), () => cb.toggleNote(), false)
    this.root.replaceChildren(this.spacer, this.modes, this.changes, this.images, this.messages, this.docs, this.note)
    // files dropped on the header are attached to the chat in front, as a drop on the sheet is
    this.root.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    })
    this.root.addEventListener('drop', (e) => {
      e.preventDefault()
      cb.drop(Array.from(e.dataTransfer?.files ?? []))
    })
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
    // a redraw that changes nothing visible keeps the title's element: a double click on the title must not straddle a rebuild
    const key = signature(item, deviceColor)
    if (this.editing || key === this.key) return
    this.key = key
    this.drawLeft()
  }

  /**
   * The Chat | Terminal switch of the tab in front; null hides it (a shell tab). Both buttons are disabled while Claude works.
   * A switch that would stop background tasks waits for the user's word in the confirm row, and that question is the tab's own:
   * when another tab comes to the front, or the view changes, or no task is left, it goes, and its Cancel keeps the text.
   */
  setModes(m: SheetModes | null): void {
    this.modes.hidden = m === null
    this.tab = m?.tab ?? null
    this.view = m?.view ?? null
    this.busy = m?.busy ?? false
    this.background = m?.background ?? 0
    const p = this.pending
    if (p !== null) {
      if (m === null || m.tab !== p.tab || m.view !== p.from || this.background === 0) {
        this.pending = null
        p.cancel()
      } else p.count = this.background
    }
    this.drawModes()
  }

  /**
   * A switch the user makes from the composer, or any other that would stop background tasks: it waits for the user's word in
   * the confirm row. `go` runs on Switch, `cancel` on Cancel or when the question is dropped. `background` is the tab's own count
   * of its background tasks; with none, `go` runs at once. `ask` gives the question's words (a resume's, say).
   * The returned function takes the question away without answering it, for an owner that no longer wants the switch.
   */
  askBeforeSwitch(tab: string, background: number, go: () => void, cancel: () => void, ask: SwitchAsk = SWITCH_ASK): () => void {
    if (background === 0) {
      go()
      return () => undefined
    }
    // a question that is up is replaced: its owner is cancelled, and its switch does not run
    const replaced = this.pending
    this.pending = null
    replaced?.cancel()
    // a question for a tab that is not in front has nothing to ask here: its owner is cancelled at once
    if (this.tab !== tab) {
      cancel()
      return () => undefined
    }
    const entry = { tab, go, cancel, from: this.view, count: background, ask }
    this.pending = entry
    this.drawModes()
    // the owner dropped its switch (its command was cleared): the question goes, and nothing is run or cancelled
    return () => {
      if (this.pending !== entry) return
      this.pending = null
      this.drawModes()
    }
  }

  private modeButton(view: TabView, label: string, iconName: IconName): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'sh-mode'
    b.dataset.view = view
    b.innerHTML = icon(iconName, 14) + `<span class="sh-label">${label}</span>`
    b.addEventListener('click', () => this.choose(view))
    return b
  }

  private confirmButton(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'sh-mode-confirm-button'
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  private choose(view: TabView): void {
    if (view === this.view || this.busy) return
    if (this.background === 0) {
      this.cb.switchView(view)
      return
    }
    if (this.tab === null) return
    this.askBeforeSwitch(this.tab, this.background, () => this.cb.switchView(view), () => undefined)
  }

  private confirmSwitch(): void {
    const p = this.pending
    this.pending = null
    this.drawModes()
    p?.go()
  }

  private cancelSwitch(): void {
    const p = this.pending
    this.pending = null
    this.drawModes()
    p?.cancel()
  }

  private drawModes(): void {
    for (const b of [this.chatMode, this.terminalMode]) {
      b.setAttribute('aria-pressed', String(b.dataset.view === this.view))
      b.disabled = this.busy
      b.title = this.busy ? WORKING_SWITCH : b.textContent ?? ''
    }
    const p = this.pending
    this.confirm.hidden = p === null
    if (p !== null) {
      const n = p.count
      this.confirmText.textContent = `${n} background task${n === 1 ? '' : 's'} will stop. ${p.ask.question}`
      this.switchButton.textContent = p.ask.action
    }
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
      // while the tab works, its glyph steps here too, in step with the tab's own (the spinner starts at the same phase)
      const kind = tabIcon(item)
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
