import type { DeviceResult } from '../shared/devices'
import { REMOTE_COPY, type FolderListing, type FolderResult } from '../shared/remote'
import { el } from './dom'

export interface FolderDialogCallbacks {
  /** the listing of a folder (null: the tab's own folder) as the tab's device gives it, or the device's message */
  list(path: string | null): Promise<FolderResult>
  /** moves the tab to the folder, as the tab's device does it */
  open(path: string): Promise<DeviceResult>
  /** the dialog closed: the keyboard goes back to the terminal */
  closed(): void
}

/** the recent folders of the first listing, kept for as long as the dialog is open */
interface Recents {
  device: string
  folders: string[]
}

/**
 * Change folder…: the folders of a tab's device, a field for a typed folder and Open here. Every name and message comes from
 * the device, so it is set as text. One request is out at a time, and an answer for an older request, or one that comes
 * after the dialog closed, is dropped.
 */
export class FolderDialog {
  private readonly title: HTMLElement
  private readonly path: HTMLInputElement
  private readonly error: HTMLElement
  private readonly recentBox: HTMLElement
  private readonly recentLabel: HTMLElement
  private readonly list: HTMLElement
  private readonly openHere: HTMLButtonElement
  private cb: FolderDialogCallbacks | null = null
  private listing: FolderListing | null = null
  private recents: Recents | null = null
  /** counts the requests: an answer for an older one is dropped */
  private seq = 0
  /** a listing or an Open here is out: the list and Open here wait for it */
  private pending = false
  /** the latest Enter or item click made while a request was out: it is sent when that answer comes */
  private queued: { path: string | null } | null = null
  /** the user typed into the field since the last request was sent: the field keeps the text over a listing's answer */
  private typed = false

  constructor(private readonly root: HTMLElement) {
    this.title = el('div', { className: 'folder-title' })
    this.path = el('input', { className: 'folder-path', spellcheck: false })
    this.error = el('div', { className: 'folder-error', hidden: true })
    this.recentLabel = el('div', { className: 'folder-recent-label' })
    this.recentBox = el('div', { className: 'folder-recent', hidden: true })
    this.list = el('div', { className: 'folder-list' })
    const cancel = el('button', { className: 'folder-cancel', textContent: REMOTE_COPY.cancel })
    this.openHere = el('button', { className: 'folder-open', textContent: REMOTE_COPY.openHere, disabled: true })
    root.replaceChildren(el('div', { className: 'folder-dialog' }, this.title, this.path, this.error, this.recentBox, this.list, el('div', { className: 'folder-actions' }, cancel, this.openHere)))
    root.addEventListener('mousedown', (e) => { if (e.target === root) this.close() })
    // the dialog is modal: its keys stay in it, and Escape closes it
    root.addEventListener('keydown', (e) => {
      e.stopPropagation()
      // Tab stays in the dialog, as in the sessions window
      if (e.key === 'Tab') e.preventDefault()
      else if (e.key === 'Escape') {
        e.preventDefault()
        this.close()
      } else if (e.key === 'Enter' && e.target === this.path) {
        e.preventDefault()
        void this.load(this.path.value)
      }
    })
    cancel.addEventListener('click', () => this.close())
    this.openHere.addEventListener('click', () => { if (this.listing) void this.choose(this.listing.path) })
    this.path.addEventListener('input', () => { this.typed = true })
    // a click on a folder row takes the focus out of the field, as a row cannot hold it: the field takes it back while the dialog is open
    this.path.addEventListener('blur', () => { if (this.isOpen) this.path.focus() })
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  /** shows the dialog on the tab's folder listing; `tabId` marks the tab whose folder changes */
  open(title: string, tabId: string, cb: FolderDialogCallbacks): void {
    this.seq++
    this.cb = cb
    this.listing = null
    this.recents = null
    this.pending = false
    this.queued = null
    this.typed = false
    this.root.dataset.folderTab = tabId
    this.title.textContent = title
    this.path.value = ''
    this.list.replaceChildren()
    this.showError('')
    this.recentBox.hidden = true
    this.root.hidden = false
    this.refresh()
    this.path.focus()
    void this.load(null)
  }

  private close(): void {
    if (!this.isOpen) return
    // an answer that is still out is dropped, and so is the request it answers
    this.seq++
    this.pending = false
    this.queued = null
    this.root.hidden = true
    const cb = this.cb
    this.cb = null
    cb?.closed()
  }

  /** lists a folder: the tab's own (null) or the one given; a request made while one is out is kept and sent when it answers */
  private async load(path: string | null): Promise<void> {
    const cb = this.cb
    if (!cb) return
    if (this.pending) {
      // only the latest is kept
      this.queued = { path }
      return
    }
    if (path !== null) this.typed = false
    const id = ++this.seq
    this.busy(true)
    const answer = await cb.list(path).catch((): FolderResult => ({ ok: false, error: REMOTE_COPY.folderUnreadable }))
    if (!this.current(id, cb)) return
    this.busy(false)
    if (answer.ok) {
      this.showError('')
      // only the first listing carries the recent folders: they stay as they were for the rest of the dialog
      if (path === null) this.recents = answer.listing.recent.length > 0 ? { device: answer.listing.device, folders: answer.listing.recent } : null
      this.show(answer.listing)
    } else {
      this.showError(answer.error)
    }
    this.sendQueued()
  }

  private async choose(path: string): Promise<void> {
    const cb = this.cb
    if (!cb || this.pending) return
    const id = ++this.seq
    this.busy(true)
    const answer = await cb.open(path).catch((): DeviceResult => ({ ok: false, error: REMOTE_COPY.folderChangeFailed }))
    if (!this.current(id, cb)) return
    this.busy(false)
    if (answer.ok) {
      this.close()
      return
    }
    this.showError(answer.error)
    this.sendQueued()
  }

  /** the request kept while one was out goes now */
  private sendQueued(): void {
    const next = this.queued
    this.queued = null
    if (next) void this.load(next.path)
  }

  /** an answer is the current one only while the dialog is open on the same callbacks and no later request went out */
  private current(id: number, cb: FolderDialogCallbacks): boolean {
    return this.isOpen && id === this.seq && cb === this.cb
  }

  private busy(on: boolean): void {
    this.pending = on
    this.refresh()
  }

  private refresh(): void {
    this.openHere.disabled = this.pending || this.listing === null
  }

  private showError(message: string): void {
    this.error.textContent = message
    this.error.hidden = message === ''
  }

  private show(listing: FolderListing): void {
    this.listing = listing
    // the field shows the folder listed, unless the user has typed into it since the request: that text is theirs until they send it
    if (!this.typed) this.path.value = listing.path
    // a folder item lists the folder's path, a separator unless the path has one, and the name
    const inside = listing.path.endsWith(listing.sep) ? listing.path : listing.path + listing.sep
    const rows = [
      ...(listing.parent === null ? [] : [this.item('..', listing.parent)]),
      ...listing.folders.map((name) => this.item(name, inside + name))
    ]
    this.list.replaceChildren(...rows)
    this.list.scrollTop = 0
    this.renderRecents()
    this.refresh()
  }

  private renderRecents(): void {
    const recents = this.recents
    this.recentBox.hidden = recents === null
    if (recents === null) {
      this.recentBox.replaceChildren()
      return
    }
    this.recentLabel.textContent = REMOTE_COPY.recentOn(recents.device)
    this.recentBox.replaceChildren(this.recentLabel, ...recents.folders.map((folder) => this.item(folder, folder)))
  }

  private item(label: string, target: string): HTMLElement {
    const row = el('div', { className: 'folder-item', textContent: label })
    row.addEventListener('click', () => void this.load(target))
    return row
  }
}
