import type { ReviewFile, ReviewFileNote, ReviewHunk, ReviewLine, ReviewScope, ReviewUpdate } from '../shared/review'
import { showMenu } from './menu'
import {
  anchorOf, attemptSend, describeLines, draftAfterSend, formatSendMessage, locate, moveAnchor, reanchorComment, sendErrorAfter, viewKeyOf,
  type CommentAnchor, type Located, type ReviewComment
} from './review-comments'
import type { SidePanel } from './side-panel'

export interface ReviewPanelCallbacks {
  setScope(tabId: string, scope: ReviewScope): void
  clearRequest(tabId: string): void
  refresh(tabId: string): void
  setViewed(tabId: string, path: string, hash: string, viewed: boolean): void
  showFile(tabId: string, path: string): void
  openEditor(tabId: string, path: string, line: number): void
  copyText(text: string): void
  /** writes the message into Claude's prompt and presses Enter; resolves to null, or to why it was not sent */
  send(tabId: string, message: string): Promise<string | null>
}

const SCOPES: { scope: ReviewScope; label: string }[] = [
  { scope: 'uncommitted', label: 'Uncommitted' },
  { scope: 'last_turn', label: 'Last turn' },
  { scope: 'session', label: 'Session' }
]
/** a file with more changed lines than this starts folded */
export const FOLD_LINES = 1000
const NOTES: Record<ReviewFileNote, string> = {
  binary: 'binary',
  'too-large': 'too large',
  'eol-only': 'line endings changed only',
  'no-baseline': 'no baseline — use Uncommitted',
  submodule: 'submodule',
  unreadable: "can't be read",
  'too-many': 'not shown'
}
const STATUS: Record<ReviewFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D' }

interface Draft {
  anchor: CommentAnchor
  text: string
  /** the comment being edited; null for a new one */
  editing: string | null
}

interface TabComments {
  comments: ReviewComment[]
  draft: Draft | null
  /** files folded or unfolded by hand: path → folded */
  folds: Map<string, boolean>
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/** the new-side line to open in an editor for a line of a hunk: its own, or the nearest one */
function editorLine(h: ReviewHunk, index: number): number {
  for (let i = index; i < h.lines.length; i++) if (h.lines[i]!.newNo !== null) return h.lines[i]!.newNo!
  for (let i = index; i >= 0; i--) if (h.lines[i]!.newNo !== null) return h.lines[i]!.newNo!
  return 1
}

const firstLine = (f: ReviewFile): number => (f.hunks[0] ? editorLine(f.hunks[0], 0) : 1)

let nextId = 1

/** the longest a panel waits for the view after a click */
const LOADING_MAX_MS = 10_000

/** The Changes panel: scopes, files, hunks, comments and Send. */
export class ReviewPanel {
  private update: ReviewUpdate | null = null
  private readonly perTab = new Map<string, TabComments>()
  private readonly scopeBar = el('div', 'review-scope')
  private readonly noticeEl = el('div', 'panel-notice')
  private readonly outsideEl = el('div', 'review-outside')
  private readonly filesEl = el('div', 'review-files')
  private readonly footer = el('div', 'review-footer')
  private readonly countEl = el('span', 'review-count')
  private readonly sendBtn = el('button', 'review-send', 'Send to Claude')
  private readonly expandBtn = el('button', 'review-expand', '⤢')
  private draftArea: HTMLTextAreaElement | null = null
  private drag: { file: number; hunk: number; from: number; to: number } | null = null
  private sending = false
  private sendError: string | null = null
  private wasShowing = false
  /** a scope switch or a Refresh waits for its update: the clicked scope shows active and the list dims meanwhile */
  private loading: { tabId: string; scope: ReviewScope | null } | null = null
  private loadingTimer: ReturnType<typeof setTimeout> | null = null
  private readonly samePath: (a: string, b: string) => boolean

  constructor(private readonly root: HTMLElement, private readonly panel: SidePanel, private readonly cb: ReviewPanelCallbacks, platform: string) {
    this.samePath = platform === 'win32' ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b
    const refresh = el('button', 'review-refresh', '⟳')
    refresh.title = 'Refresh'
    refresh.addEventListener('click', () => {
      if (!this.update) return
      this.cb.refresh(this.update.tabId)
      this.startLoading(this.update.tabId, null)
    })
    this.expandBtn.title = 'Expand'
    this.expandBtn.addEventListener('click', () => this.panel.setExpanded(!this.panel.expanded))
    panel.tools.append(refresh, this.expandBtn)
    this.sendBtn.addEventListener('click', () => void this.sendAll())
    this.footer.append(this.countEl, this.sendBtn)
    root.replaceChildren(this.scopeBar, this.noticeEl, this.outsideEl, this.filesEl, this.footer)
    document.addEventListener('mouseup', () => this.endDrag())
    this.render()
  }

  /** the active tab's review; null for a shell tab. While Changes is hidden it is only kept: the rows are built when it shows */
  show(update: ReviewUpdate | null): void {
    this.sendError = sendErrorAfter(this.sendError, this.update?.tabId ?? null, update)
    this.update = update
    // a scope switch waits for a view of that scope (a notice or an error comes as that scope's view too), a Refresh for the next update
    // of the tab; a state-only update (viewed, Send) is the same shape, so it ends a Refresh early. The timer ends any wait
    const l = this.loading
    if (!l || !update || update.tabId !== l.tabId || l.scope === null || update.view.kind !== 'scope' || update.view.scope === l.scope) this.endLoading()
    if (update) this.reanchor(update)
    if (this.panel.isShowing('changes')) this.render()
  }

  /** the click is sent first, then only classes change: the clicked scope is active and the list dims until its view arrives */
  private startLoading(tabId: string, scope: ReviewScope | null): void {
    if (this.loadingTimer) clearTimeout(this.loadingTimer)
    this.loading = { tabId, scope }
    // a compute that fails publishes nothing: the panel must not stay dimmed
    this.loadingTimer = setTimeout(() => {
      this.endLoading()
      if (this.panel.isShowing('changes')) this.render()
    }, LOADING_MAX_MS)
    this.root.classList.add('review-loading')
    if (scope) for (const b of this.scopeBar.querySelectorAll<HTMLElement>('.review-seg-btn')) b.classList.toggle('active', b.dataset.scope === scope)
  }

  private endLoading(): void {
    if (this.loadingTimer) clearTimeout(this.loadingTimer)
    this.loadingTimer = null
    this.loading = null
  }

  dropTab(tabId: string): void {
    this.perTab.delete(tabId)
  }

  /** the side panel changed: opening Changes shows what it kept and recomputes it */
  panelChanged(): void {
    this.expandBtn.classList.toggle('active', this.panel.expanded)
    const showing = this.panel.isShowing('changes')
    if (showing && !this.wasShowing) {
      this.render()
      if (this.update) this.cb.refresh(this.update.tabId)
    }
    this.wasShowing = showing
  }

  private state(tabId: string): TabComments {
    let s = this.perTab.get(tabId)
    if (!s) {
      s = { comments: [], draft: null, folds: new Map() }
      this.perTab.set(tabId, s)
    }
    return s
  }

  /** comments written in this view follow their lines; ones whose lines are gone from their file become outdated */
  private reanchor(u: ReviewUpdate): void {
    const s = this.state(u.tabId)
    const key = viewKeyOf(u)
    s.comments = s.comments.map((c) => (c.anchor.viewKey === key ? reanchorComment(c, u.files, this.samePath) : c))
    if (s.draft?.anchor.viewKey === key) {
      const at = locate(s.draft.anchor, u.files, this.samePath)
      if (at) s.draft.anchor = moveAnchor(s.draft.anchor, u.files, at)
    }
  }

  private render(): void {
    const u = this.update
    // keep the comment being typed, its focus and caret, across the re-render
    const prev = this.draftArea
    const caret = prev !== null && document.activeElement === prev ? ([prev.selectionStart, prev.selectionEnd] as const) : null
    this.draftArea = null
    this.root.classList.toggle('review-loading', this.loading !== null)
    if (!u) {
      this.scopeBar.replaceChildren()
      this.noticeEl.hidden = true
      this.outsideEl.replaceChildren()
      this.outsideEl.hidden = true
      this.filesEl.replaceChildren(el('div', 'panel-empty', 'No changes'))
      this.footer.hidden = true
      return
    }
    const s = this.state(u.tabId)
    this.renderScope(u)
    this.noticeEl.textContent = u.notice ?? ''
    this.noticeEl.hidden = !u.notice
    const placed = new Map<string, ReviewComment[]>()
    const outside: ReviewComment[] = []
    for (const c of s.comments) {
      const at = c.outdated ? null : locate(c.anchor, u.files, this.samePath)
      if (!at) {
        outside.push(c)
        continue
      }
      const key = `${at.file}:${at.hunk}:${at.to}`
      placed.set(key, [...(placed.get(key) ?? []), c])
    }
    const draftAt = s.draft ? locate(s.draft.anchor, u.files, this.samePath) : null
    this.renderOutside(u, s, outside, s.draft !== null && draftAt === null)
    this.filesEl.replaceChildren(
      ...(u.files.length === 0 ? [el('div', 'panel-empty', 'No changes in this view')] : u.files.map((f, i) => this.renderFile(u, s, f, i, placed, draftAt)))
    )
    this.renderFooter(u, s)
    if (caret) this.focusDraft(caret)
  }

  /** focus the comment box, with the caret where it was; a method of its own, so that TypeScript reads draftArea anew */
  private focusDraft(caret?: readonly [number, number]): void {
    const area = this.draftArea
    if (!area) return
    area.focus()
    if (caret) area.setSelectionRange(caret[0], caret[1])
  }

  private renderScope(u: ReviewUpdate): void {
    const parts: HTMLElement[] = []
    if (u.view.kind === 'request') {
      const chip = el('span', 'review-chip')
      const close = el('button', 'review-chip-close', '✕')
      close.title = 'Back to the scopes'
      close.addEventListener('click', () => this.cb.clearRequest(u.tabId))
      chip.append(el('span', 'review-chip-text', u.label), close)
      parts.push(chip)
    } else {
      const current = (this.loading?.tabId === u.tabId ? this.loading.scope : null) ?? u.view.scope
      const seg = el('div', 'review-seg')
      for (const s of SCOPES) {
        const b = el('button', `review-seg-btn${current === s.scope ? ' active' : ''}`, s.label)
        b.dataset.scope = s.scope
        if (s.scope === 'uncommitted' && !u.uncommitted.available) {
          b.disabled = true
          b.title = u.uncommitted.reason
        }
        b.addEventListener('click', () => {
          this.cb.setScope(u.tabId, s.scope)
          this.startLoading(u.tabId, s.scope)
        })
        seg.append(b)
      }
      parts.push(seg)
    }
    const n = u.files.length
    const summary = el('span', 'review-summary')
    summary.append(`${n} file${n === 1 ? '' : 's'} · `, el('span', 'review-add', `+${u.additions}`), ' ', el('span', 'review-del', `−${u.deletions}`))
    if (u.outside > 0) {
      const left = el('span', 'review-hidden-outside', ` · ${u.outside} outside the folder`)
      const more = u.outside - u.outsideSample.length
      left.title = [`Files outside ${u.folder} are not shown:`, ...u.outsideSample, ...(more > 0 ? [`…and ${more} more`] : [])].join('\n')
      summary.append(left)
    }
    if (u.ignored > 0) {
      const hidden = el('span', 'review-ignored', ` · ${u.ignored} ignored`)
      hidden.title = 'Files git ignores are hidden (review.hideIgnored)'
      summary.append(hidden)
    }
    this.scopeBar.replaceChildren(...parts, summary)
  }

  private renderOutside(u: ReviewUpdate, s: TabComments, outside: ReviewComment[], draftHere: boolean): void {
    const items: HTMLElement[] = []
    if (outside.length > 0 || draftHere) {
      items.push(el('div', 'review-outside-title', `Comments outside this view (${outside.length})`))
      for (const c of outside) if (s.draft?.editing !== c.id) items.push(this.renderComment(s, c))
      if (draftHere) items.push(this.renderDraft(u, s))
    }
    this.outsideEl.replaceChildren(...items)
    this.outsideEl.hidden = items.length === 0
  }

  private renderFile(u: ReviewUpdate, s: TabComments, f: ReviewFile, fi: number, placed: Map<string, ReviewComment[]>, draftAt: Located | null): HTMLElement {
    const box = el('div', `review-file${f.viewed ? ' viewed' : ''}`)
    box.dataset.path = f.relPath
    const folded = s.folds.get(f.path) ?? (f.viewed || f.additions + f.deletions > FOLD_LINES)
    const head = el('div', 'review-file-head')
    const viewed = el('input', 'review-viewed')
    viewed.type = 'checkbox'
    viewed.checked = f.viewed
    viewed.title = 'Viewed'
    viewed.addEventListener('click', (e) => e.stopPropagation())
    viewed.addEventListener('change', () => {
      s.folds.delete(f.path)
      this.cb.setViewed(u.tabId, f.path, f.hash, viewed.checked)
    })
    const slash = f.relPath.lastIndexOf('/')
    const name = el('span', 'review-name')
    name.append(el('span', 'review-dir', slash >= 0 ? f.relPath.slice(0, slash + 1) : ''), f.relPath.slice(slash + 1))
    name.title = f.path
    const counts = el('span', 'review-counts')
    counts.append(el('span', 'review-add', `+${f.additions}`), ' ', el('span', 'review-del', `−${f.deletions}`))
    const more = el('button', 'review-more', '⋯')
    more.title = 'More'
    more.addEventListener('click', (e) => {
      e.stopPropagation()
      const r = more.getBoundingClientRect()
      showMenu({ x: r.left, y: r.bottom }, [
        { label: 'Open in editor', action: () => this.cb.openEditor(u.tabId, f.path, firstLine(f)) },
        { label: 'Copy path', action: () => this.cb.copyText(f.path) }
      ])
    })
    head.append(viewed, el('span', 'review-arrow', folded ? '▸' : '▾'), name, el('span', `review-status ${f.status}`, STATUS[f.status]), counts, more)
    head.addEventListener('click', () => {
      s.folds.set(f.path, !folded)
      this.render()
    })
    box.append(head)
    if (folded) return box
    if (f.note) {
      const row = el('div', 'review-note', NOTES[f.note])
      if (f.note === 'too-large' && f.canForce) {
        const link = el('button', 'review-force', 'show anyway')
        link.addEventListener('click', () => this.cb.showFile(u.tabId, f.path))
        row.append(' — ', link)
      }
      box.append(row)
      return box
    }
    f.hunks.forEach((h, hi) => box.append(this.renderHunk(u, s, f, fi, h, hi, placed, draftAt)))
    return box
  }

  private renderHunk(u: ReviewUpdate, s: TabComments, f: ReviewFile, fi: number, h: ReviewHunk, hi: number, placed: Map<string, ReviewComment[]>, draftAt: Located | null): HTMLElement {
    const box = el('div', 'review-hunk')
    box.append(el('div', 'review-hunk-head', h.header))
    h.lines.forEach((line: ReviewLine, li) => {
      const row = el('div', `review-line ${line.kind}`)
      row.dataset.file = String(fi)
      row.dataset.hunk = String(hi)
      row.dataset.line = String(li)
      const gutter = el('span', 'review-gutter')
      const no = line.newNo ?? line.oldNo
      gutter.append(el('span', 'review-no', no === null ? '' : String(no)))
      const plus = el('span', 'review-plus', '+')
      plus.title = 'Comment'
      plus.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.drag = { file: fi, hunk: hi, from: li, to: li }
        this.markDrag()
      })
      gutter.append(plus)
      row.addEventListener('mouseenter', () => {
        if (this.drag && this.drag.file === fi && this.drag.hunk === hi) {
          this.drag.to = li
          this.markDrag()
        }
      })
      row.append(gutter, el('span', 'review-code', line.text))
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const at = editorLine(h, li)
        showMenu({ x: e.clientX, y: e.clientY }, [
          { label: 'Comment', action: () => this.startDraft(u, f, h, li, li) },
          { label: `Open in editor at line ${at}`, action: () => this.cb.openEditor(u.tabId, f.path, at) },
          { label: 'Copy path:line', action: () => this.cb.copyText(`${f.relPath}:${no ?? at}`) }
        ])
      })
      box.append(row)
      for (const c of placed.get(`${fi}:${hi}:${li}`) ?? []) if (s.draft?.editing !== c.id) box.append(this.renderComment(s, c))
      if (s.draft && draftAt && draftAt.file === fi && draftAt.hunk === hi && draftAt.to === li) box.append(this.renderDraft(u, s))
    })
    return box
  }

  private markDrag(): void {
    const d = this.drag
    for (const row of this.filesEl.querySelectorAll<HTMLElement>('.review-line')) {
      const li = Number(row.dataset.line)
      const on = d !== null && Number(row.dataset.file) === d.file && Number(row.dataset.hunk) === d.hunk && li >= Math.min(d.from, d.to) && li <= Math.max(d.from, d.to)
      row.classList.toggle('selected', on)
    }
  }

  private endDrag(): void {
    const d = this.drag
    if (!d) return
    this.drag = null
    const u = this.update
    const f = u?.files[d.file]
    const h = f?.hunks[d.hunk]
    if (u && f && h) this.startDraft(u, f, h, Math.min(d.from, d.to), Math.max(d.from, d.to))
    else this.markDrag()
  }

  private startDraft(u: ReviewUpdate, f: ReviewFile, h: ReviewHunk, from: number, to: number): void {
    this.state(u.tabId).draft = { anchor: anchorOf(f, h.lines.slice(from, to + 1), viewKeyOf(u)), text: '', editing: null }
    this.render()
    this.focusDraft()
  }

  private renderDraft(u: ReviewUpdate, s: TabComments): HTMLElement {
    const d = s.draft!
    const box = el('div', 'review-comment-box')
    box.append(el('div', 'review-comment-meta', describeLines(d.anchor)))
    const area = el('textarea', 'review-comment-input')
    area.value = d.text
    area.placeholder = 'Comment for Claude'
    area.addEventListener('input', () => { d.text = area.value })
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault()
        this.saveDraft(u.tabId)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.cancelDraft(u.tabId)
      }
    })
    const cancel = el('button', 'review-btn', 'Cancel')
    cancel.addEventListener('click', () => this.cancelDraft(u.tabId))
    const save = el('button', 'review-btn primary', d.editing ? 'Save' : 'Add comment')
    save.addEventListener('click', () => this.saveDraft(u.tabId))
    const buttons = el('div', 'review-comment-btns')
    buttons.append(cancel, save)
    box.append(area, buttons)
    this.draftArea = area
    return box
  }

  private saveDraft(tabId: string): void {
    const s = this.state(tabId)
    const d = s.draft
    if (!d) return
    const text = d.text.trim()
    if (text === '') {
      this.cancelDraft(tabId)
      return
    }
    if (d.editing) {
      const c = s.comments.find((x) => x.id === d.editing)
      if (c) c.text = text
    } else {
      s.comments.push({ id: `c${nextId++}`, anchor: d.anchor, text, outdated: false })
    }
    s.draft = null
    // the comments changed: a refusal of the last Send is old news
    this.sendError = null
    this.render()
  }

  private cancelDraft(tabId: string): void {
    this.state(tabId).draft = null
    this.render()
  }

  private renderComment(s: TabComments, c: ReviewComment): HTMLElement {
    const box = el('div', `review-comment${c.outdated ? ' outdated' : ''}`)
    const meta = el('div', 'review-comment-meta', `${c.anchor.relPath} · ${describeLines(c.anchor)}`)
    if (c.outdated) meta.append(' · ', el('span', 'review-outdated', 'outdated'))
    const edit = el('button', 'review-link', 'Edit')
    edit.addEventListener('click', () => {
      s.draft = { anchor: c.anchor, text: c.text, editing: c.id }
      this.render()
      this.focusDraft()
    })
    const del = el('button', 'review-link', 'Delete')
    del.addEventListener('click', () => {
      s.comments = s.comments.filter((x) => x.id !== c.id)
      this.sendError = null
      this.render()
    })
    const buttons = el('div', 'review-comment-btns')
    buttons.append(edit, del)
    box.append(meta, el('div', 'review-comment-text', c.text), buttons)
    return box
  }

  private renderFooter(u: ReviewUpdate, s: TabComments): void {
    const n = s.comments.length
    this.footer.hidden = false
    this.countEl.textContent = this.sendError ?? `${n} comment${n === 1 ? '' : 's'}`
    this.countEl.classList.toggle('error', this.sendError !== null)
    const blocked = u.send.ok ? null : u.send.reason
    this.sendBtn.disabled = n === 0 || blocked !== null || this.sending
    // a Send refused at the last moment keeps the comments, and the button says why
    this.sendBtn.title = blocked ?? this.sendError ?? ''
  }

  private async sendAll(): Promise<void> {
    const u = this.update
    if (!u || this.sending) return
    const s = this.state(u.tabId)
    if (s.comments.length === 0) return
    this.sending = true
    this.sendError = null
    this.renderFooter(u, s)
    let error: string | null
    // `sending` is shared by every tab: a failure must not leave Send disabled
    try {
      error = await attemptSend(() => this.cb.send(u.tabId, formatSendMessage(u.label, s.comments)))
    } finally {
      this.sending = false
    }
    this.sendError = error
    if (error === null) {
      s.comments = []
      s.draft = draftAfterSend(s.draft)
    }
    this.render()
  }
}
