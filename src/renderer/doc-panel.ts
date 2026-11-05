import type { ReviewLine } from '../shared/review'
import { docImageUrl, type DocAction, type DocInfo, type DocRead, type DocsUpdate } from '../shared/docs'
import { docLines } from './doc-lines'
import { markdownSegments, segmentOf } from './markdown-diff'
import { showMenu } from './menu'
import {
  anchorOf, attemptSend, describeLines, draftAfterSend, formatDocMessage, locate, location, moveAnchor, reanchorComment, withoutSent,
  type CommentAnchor, type CommentFile, type ReviewComment
} from './review-comments'
import type { SidePanel } from './side-panel'

export interface DocPanelCallbacks {
  read(docId: string): Promise<DocRead>
  stamp(docId: string): Promise<string | null>
  action(docId: string, action: DocAction): void
  openEditor(docId: string, line: number): void
  copyText(text: string): void
  openLink(url: string): void
  send(tabId: string, message: string): Promise<string | null>
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

interface Draft {
  anchor: CommentAnchor
  text: string
  /** the comment being edited; null for a new one */
  editing: string | null
}

/** what the panel keeps of one document of a tab: its comments, and the draft being typed */
interface DocComments {
  comments: ReviewComment[]
  draft: Draft | null
}

/** a document as shown: its lines as the one file of context a comment is anchored in, and what is kept for it */
interface DocView {
  doc: DocInfo
  file: CommentFile
  lines: ReviewLine[]
  s: DocComments
}

/** where a drag of the + began and where it is now: line ranges of the shown document */
interface Drag {
  view: DocView
  start: readonly [number, number]
  end: readonly [number, number]
}

/** the lines a drag covers, from..to */
const dragRange = (d: Drag): [number, number] => [Math.min(d.start[0], d.end[0]), Math.max(d.start[1], d.end[1])]

/** a document as the panel keeps it: its tab and its id */
const keyOf = (tabId: string, docId: string): string => `${tabId}/${docId}`

let nextId = 1

/** how often the panel asks main whether the shown file changed */
const LIVE_CHECK_MS = 1000

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The Docs panel: the documents of the active Claude tab, one shown at a time. The selector chooses among them, each tab
 * keeps its own choice, and a document show_document just showed is the one selected.
 */
export class DocPanel {
  private current: DocsUpdate | null = null
  /** the document each tab shows, by id; a tab without a choice shows its newest */
  private readonly shownBy = new Map<string, string>()
  /** a read that comes back after the selection changed is dropped */
  private readSeq = 0
  private readonly noticeEl = el('div', 'panel-notice')
  private readonly contentEl = el('div', 'doc-content')
  private readonly selectEl = el('select', 'doc-select')
  private readonly moreBtn = el('button', 'doc-more', '⋯')
  private readonly expandBtn = el('button', 'doc-expand', '⤢')
  /** the comments and the draft of each document, by tab and then by document id */
  private readonly perTab = new Map<string, Map<string, DocComments>>()
  private drag: Drag | null = null
  private draftArea: HTMLTextAreaElement | null = null
  /** a draft just started or edited takes the focus when its document is shown */
  private focusOnShow = false
  /** the caret of the draft being typed, kept while its document is read again */
  private keptCaret: readonly [number, number] | null = null
  private readonly footerEl = el('div', 'review-footer')
  private readonly countEl = el('span', 'review-count')
  private readonly sendBtn = el('button', 'review-send', 'Send to Claude')
  private readonly samePath: (a: string, b: string) => boolean
  private sending = false
  private sendError: string | null = null
  /** the stamp of the shown document's file as the panel last saw it; null when the file was gone; null here until the first answer */
  private seen: { docId: string; stamp: string | null } | null = null
  /** the document drawn in the content, by its key, with the text a Markdown document was drawn from; a frame or a notice has none */
  private drawn: { key: string; text: string | null } | null = null
  /** the frame a PDF or HTML document is shown in */
  private frameEl: HTMLIFrameElement | null = null
  private liveTimer: ReturnType<typeof setInterval> | null = null
  /** whether Docs was shown at the last change of the side panel */
  private wasShowing = false

  constructor(root: HTMLElement, private readonly panel: SidePanel, private readonly cb: DocPanelCallbacks, private readonly platform: string) {
    this.samePath = platform === 'win32' ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b
    this.selectEl.addEventListener('change', () => {
      const u = this.current
      if (!u) return
      this.shownBy.set(u.tabId, this.selectEl.value)
      this.render()
    })
    this.moreBtn.title = 'More'
    this.moreBtn.addEventListener('click', () => this.openMenu())
    this.expandBtn.title = 'Expand'
    this.expandBtn.addEventListener('click', () => this.panel.setExpanded(!this.panel.expanded))
    panel.tools.docs.append(this.selectEl, this.moreBtn, this.expandBtn)
    this.sendBtn.addEventListener('click', () => void this.sendAll())
    this.footerEl.append(this.countEl, this.sendBtn)
    root.replaceChildren(this.noticeEl, this.contentEl)
    document.addEventListener('mouseup', () => this.endDrag())
    // a link in a formatted document never navigates the window: a web address opens in the browser, others do nothing
    this.contentEl.addEventListener('click', (e) => {
      const link = (e.target as Element | null)?.closest?.('.doc-md a')
      if (!link) return
      e.preventDefault()
      const href = link.getAttribute('href') ?? ''
      if (/^https?:\/\//i.test(href)) this.cb.openLink(href)
    })
    this.draw()
  }

  /** the active tab's documents; a reveal selects that document */
  show(update: DocsUpdate): void {
    if (this.current?.tabId !== update.tabId) this.sendError = null
    this.current = update
    this.forgetGone(update)
    if (update.reveal !== null) this.shownBy.set(update.tabId, update.reveal)
    this.render()
  }

  /** the side panel was shown, hidden or switched: the expand button is lit while the panel is expanded */
  panelChanged(): void {
    this.expandBtn.classList.toggle('active', this.panel.expanded)
    const showing = this.panel.isShowing('docs')
    // Docs shown again draws a frame document afresh, so a report blocked from a link out comes back; a Markdown document
    // keeps its drawn content, scroll position and comments (the live check redraws it if its file changed meanwhile)
    const doc = this.selected()
    if (showing && !this.wasShowing && doc !== null && doc.kind !== 'markdown') this.drawn = null
    this.wasShowing = showing
    this.render()
  }

  /** a closed tab's choice is forgotten; when it was the one shown, the panel empties */
  dropTab(tabId: string): void {
    this.shownBy.delete(tabId)
    this.perTab.delete(tabId)
    if (this.current?.tabId !== tabId) return
    this.current = null
    this.render()
  }

  /** the document the panel shows: the tab's choice, else its newest; null when there is none */
  private selected(): DocInfo | null {
    const u = this.current
    if (!u || u.docs.length === 0) return null
    return u.docs.find((d) => d.id === this.shownBy.get(u.tabId)) ?? u.docs[0]!
  }

  /** draws the panel while Docs is shown; a hidden panel draws nothing and reads nothing */
  private render(): void {
    if (this.panel.isShowing('docs')) this.draw()
    this.syncLive()
  }

  private draw(): void {
    const docs = this.current?.docs ?? []
    const doc = this.selected()
    this.selectEl.replaceChildren(...docs.map((d) => {
      const option = document.createElement('option')
      option.value = d.id
      option.textContent = d.title ?? d.name
      option.title = d.relPath
      return option
    }))
    this.selectEl.value = doc?.id ?? ''
    this.selectEl.hidden = doc === null
    this.moreBtn.hidden = doc === null
    const u = this.current
    const s = doc && u ? this.docState(u.tabId, doc.id) : null
    // a document drawn already stays as it is: it is read again only when the live check sees its file change
    const key = u && doc ? keyOf(u.tabId, doc.id) : null
    if ((this.drawn?.key ?? null) !== key) this.load(u?.tabId ?? null, doc, s)
    this.renderFooter(doc, s)
  }

  /** reads the shown document from disk and draws it; a Markdown document read again keeps what is drawn until the answer comes */
  private load(tabId: string | null, doc: DocInfo | null, s: DocComments | null): void {
    const seq = ++this.readSeq
    const key = tabId !== null && doc !== null ? keyOf(tabId, doc.id) : null
    const same = key !== null && this.drawn?.key === key
    this.keepDraftCaret()
    this.noticeEl.hidden = true
    this.noticeEl.textContent = ''
    this.drawn = key === null ? null : { key, text: null }
    this.seen = null
    if (doc === null || s === null) {
      this.clearContent()
      return
    }
    if (doc.kind !== 'markdown') {
      this.showFrame(doc)
      return
    }
    if (!same) this.clearContent()
    this.cb.read(doc.id).then(
      (r) => {
        if (seq !== this.readSeq) return
        this.seen = { docId: doc.id, stamp: r.ok ? r.stamp : null }
        if (!r.ok) {
          this.showNotice(upperFirst(r.error))
          return
        }
        if (key !== null) this.drawn = { key, text: r.text }
        const top = this.contentEl.scrollTop
        this.showBody(doc, s, r.text)
        // another document starts at its top; the same one, read again, keeps its scroll position
        this.contentEl.scrollTop = same ? top : 0
      },
      (e: unknown) => {
        if (seq === this.readSeq) this.showNotice(upperFirst(String(e)))
      }
    )
  }

  private clearContent(): void {
    this.contentEl.replaceChildren()
    this.contentEl.classList.remove('framed')
    this.frameEl = null
  }

  private showNotice(text: string): void {
    this.noticeEl.textContent = text
    this.noticeEl.hidden = false
    this.contentEl.replaceChildren()
  }

  /** shows a read document: the caret of a draft being typed is kept, and a draft just started takes the focus */
  private showBody(doc: DocInfo, s: DocComments, text: string): void {
    const caret = this.keptCaret
    this.keptCaret = null
    this.draftArea = null
    this.contentEl.replaceChildren(this.markdown(doc, s, text))
    if (caret) this.focusDraft(caret)
    else if (this.focusOnShow) this.focusDraft()
    this.focusOnShow = false
  }

  /** the draft being typed keeps its focus and caret while its document is read again */
  private keepDraftCaret(): void {
    if (this.draftArea !== null && document.activeElement === this.draftArea) this.keptCaret = [this.draftArea.selectionStart, this.draftArea.selectionEnd]
  }

  /**
   * A PDF or HTML document in a frame. The frame loads the file's version the stamp names, so the stamp is the baseline the
   * live check compares to; an HTML report runs its script in a sandbox that cannot reach the window.
   */
  private showFrame(doc: DocInfo): void {
    const seq = this.readSeq
    const frame = el('iframe', 'doc-frame')
    if (doc.kind === 'html') frame.setAttribute('sandbox', 'allow-scripts')
    this.frameEl = frame
    this.contentEl.classList.add('framed')
    this.contentEl.replaceChildren(frame)
    this.cb.stamp(doc.id).then(
      (stamp) => {
        if (seq !== this.readSeq) return
        this.seen = { docId: doc.id, stamp }
        if (stamp === null) {
          this.noticeEl.textContent = `File not found: ${doc.path}`
          this.noticeEl.hidden = false
          return
        }
        frame.src = `${doc.url}?v=${encodeURIComponent(stamp)}`
      },
      (e: unknown) => {
        if (seq !== this.readSeq) return
        // the frame is gone: the error takes its place, and a later change of the file draws the document again
        this.seen = { docId: doc.id, stamp: null }
        this.frameEl = null
        this.showNotice(upperFirst(String(e)))
      }
    )
  }

  /** the live check runs while Docs shows a document; it stops when Docs is hidden or the panel shows none */
  private syncLive(): void {
    const on = this.panel.isShowing('docs') && this.selected() !== null
    if (on && this.liveTimer === null) this.liveTimer = setInterval(() => void this.checkLive(), LIVE_CHECK_MS)
    else if (!on && this.liveTimer !== null) {
      clearInterval(this.liveTimer)
      this.liveTimer = null
    }
  }

  /** asks main for the shown file's stamp: a change redraws it, a missing file shows a notice above what is drawn */
  private async checkLive(): Promise<void> {
    const u = this.current
    const doc = this.selected()
    if (!u || !doc || !this.panel.isShowing('docs')) return
    let stamp: string | null
    try {
      stamp = await this.cb.stamp(doc.id)
    } catch {
      return
    }
    if (this.selected()?.id !== doc.id) return
    const prev = this.seen
    this.seen = { docId: doc.id, stamp }
    if (stamp === null) {
      this.noticeEl.textContent = `File not found: ${doc.path}`
      this.noticeEl.hidden = false
      return
    }
    // the first answer for a document is its baseline: only a different one after it redraws
    if (prev === null || prev.docId !== doc.id || prev.stamp === stamp) return
    this.redraw(u.tabId, doc, stamp)
  }

  /** the file changed on disk: a frame loads it again; Markdown is read again and drawn with its comments and scroll position kept */
  private redraw(tabId: string, doc: DocInfo, stamp: string): void {
    this.noticeEl.hidden = true
    this.noticeEl.textContent = ''
    if (doc.kind !== 'markdown') {
      if (this.frameEl) this.frameEl.src = `${doc.url}?v=${encodeURIComponent(stamp)}`
      else this.load(tabId, doc, this.docState(tabId, doc.id))
      return
    }
    const seq = this.readSeq
    this.cb.read(doc.id).then(
      (r) => {
        if (seq !== this.readSeq || this.selected()?.id !== doc.id) return
        this.seen = { docId: doc.id, stamp: r.ok ? r.stamp : null }
        if (!r.ok) {
          this.noticeEl.textContent = upperFirst(r.error)
          this.noticeEl.hidden = false
          return
        }
        this.drawn = { key: keyOf(tabId, doc.id), text: r.text }
        const top = this.contentEl.scrollTop
        this.keepDraftCaret()
        this.showBody(doc, this.docState(tabId, doc.id), r.text)
        this.contentEl.scrollTop = top
      },
      () => undefined
    )
  }

  /** the comments changed: the kept text of the shown Markdown document is drawn again at once, the scroll position kept */
  private redrawKept(): void {
    const u = this.current
    const doc = this.selected()
    const s = u && doc ? this.docState(u.tabId, doc.id) : null
    const d = this.drawn
    if (u && doc && s && d !== null && d.text !== null && d.key === keyOf(u.tabId, doc.id)) {
      const top = this.contentEl.scrollTop
      this.keepDraftCaret()
      this.showBody(doc, s, d.text)
      this.contentEl.scrollTop = top
    }
    this.renderFooter(doc, s)
  }

  /** focus the comment box, with the caret where it was */
  private focusDraft(caret?: readonly [number, number]): void {
    const area = this.draftArea
    if (!area) return
    area.focus()
    if (caret) area.setSelectionRange(caret[0], caret[1])
  }

  /**
   * The formatted document: the Changes panel's Markdown blocks, each with a + that comments on its lines. Under each block
   * are the comments and the draft that end in it; those whose lines are gone come after the last block.
   */
  private markdown(doc: DocInfo, s: DocComments, text: string): HTMLElement {
    const lines = docLines(text)
    const file: CommentFile = { path: doc.path, relPath: doc.relPath, note: null, hunks: [{ lines }] }
    const view: DocView = { doc, file, lines, s }
    // the comments follow their lines; one whose lines are gone becomes outdated
    s.comments = s.comments.map((c) => reanchorComment(c, [file], this.samePath))
    if (s.draft) {
      const at = locate(s.draft.anchor, [file], this.samePath)
      if (at) s.draft.anchor = moveAnchor(s.draft.anchor, [file], at)
    }
    const segs = markdownSegments(lines, { imageUrl: (src) => docImageUrl(doc, src) })
    const placed = new Map<number, ReviewComment[]>()
    const outside: ReviewComment[] = []
    for (const c of s.comments) {
      const at = c.outdated ? null : locate(c.anchor, [file], this.samePath)
      if (at) placed.set(at.to, [...(placed.get(at.to) ?? []), c])
      else outside.push(c)
    }
    const draftAt = s.draft ? locate(s.draft.anchor, [file], this.samePath) : null
    const under = segs.map((): HTMLElement[] => [])
    lines.forEach((_, li) => {
      const comments = placed.get(li) ?? []
      const draftHere = s.draft !== null && draftAt !== null && draftAt.to === li
      if (comments.length === 0 && !draftHere) return
      const at = segmentOf(segs, lines, li)
      for (const c of comments) if (s.draft?.editing !== c.id) under[at]!.push(this.renderComment(view, c))
      if (draftHere) under[at]!.push(this.renderDraft(view))
    })
    const box = el('div', 'review-md doc-md')
    segs.forEach((seg, k) => {
      const row = el('div', `md-seg ${seg.kind}${/^<(ul|ol)\b/.test(seg.html) ? ' md-list' : ''}`)
      row.dataset.from = String(seg.from)
      row.dataset.to = String(seg.to)
      const plus = el('span', 'review-plus md-plus', '+')
      plus.title = 'Comment'
      plus.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.drag = { view, start: [seg.from, seg.to], end: [seg.from, seg.to] }
        this.markDrag()
      })
      row.addEventListener('mouseenter', () => {
        if (this.drag && this.drag.view === view) {
          this.drag.end = [seg.from, seg.to]
          this.markDrag()
        }
      })
      // the HTML is markdown-it's, made with raw HTML off: the file's own markup is text in it
      const body = el('div', 'md-body')
      body.innerHTML = seg.html
      row.append(plus, body)
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        showMenu({ x: e.clientX, y: e.clientY }, [
          { label: 'Comment', action: () => this.startDraft(view, seg.from, seg.to) },
          { label: `Open in editor at line ${seg.from + 1}`, action: () => this.cb.openEditor(doc.id, seg.from + 1) },
          { label: 'Copy path:line', action: () => this.cb.copyText(location(anchorOf(file, lines.slice(seg.from, seg.to + 1), ''))) }
        ])
      })
      box.append(row, ...under[k]!)
    })
    const draftOutside = s.draft !== null && draftAt === null
    if (outside.length > 0 || draftOutside) {
      const items: HTMLElement[] = [el('div', 'review-outside-title', `Comments outside this view (${outside.length})`)]
      for (const c of outside) if (s.draft?.editing !== c.id) items.push(this.renderComment(view, c))
      if (draftOutside) items.push(this.renderDraft(view))
      const outsideBox = el('div', 'review-outside')
      outsideBox.append(...items)
      box.append(outsideBox)
    }
    return box
  }

  /** the comments and the draft of a document in a tab, made when first needed */
  private docState(tabId: string, docId: string): DocComments {
    let docs = this.perTab.get(tabId)
    if (!docs) {
      docs = new Map()
      this.perTab.set(tabId, docs)
    }
    let s = docs.get(docId)
    if (!s) {
      s = { comments: [], draft: null }
      docs.set(docId, s)
    }
    return s
  }

  /** a document that left the tab's list takes its comments with it */
  private forgetGone(u: DocsUpdate): void {
    const docs = this.perTab.get(u.tabId)
    if (!docs) return
    const listed = new Set(u.docs.map((d) => d.id))
    for (const id of [...docs.keys()]) if (!listed.has(id)) docs.delete(id)
  }

  /** the blocks a drag covers are selected */
  private markDrag(): void {
    const d = this.drag
    const [from, to] = d ? dragRange(d) : [0, -1]
    for (const seg of this.contentEl.querySelectorAll<HTMLElement>('.md-seg')) {
      const on = d !== null && Number(seg.dataset.from) >= from && Number(seg.dataset.to) <= to
      seg.classList.toggle('selected', on)
    }
  }

  private endDrag(): void {
    const d = this.drag
    if (!d) return
    this.drag = null
    const [from, to] = dragRange(d)
    this.startDraft(d.view, from, to)
  }

  private startDraft(view: DocView, from: number, to: number): void {
    view.s.draft = { anchor: anchorOf(view.file, view.lines.slice(from, to + 1), `doc:${view.doc.id}`), text: '', editing: null }
    this.focusOnShow = true
    this.redrawKept()
  }

  private renderDraft(view: DocView): HTMLElement {
    const d = view.s.draft!
    const box = el('div', 'review-comment-box')
    box.append(el('div', 'review-comment-meta', describeLines(d.anchor)))
    const area = el('textarea', 'review-comment-input')
    area.value = d.text
    area.placeholder = 'Comment for Claude'
    area.addEventListener('input', () => { d.text = area.value })
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (this.platform === 'darwin' ? e.metaKey : e.ctrlKey)) {
        e.preventDefault()
        this.saveDraft(view.s)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.cancelDraft(view.s)
      }
    })
    const cancel = el('button', 'review-btn', 'Cancel')
    cancel.addEventListener('click', () => this.cancelDraft(view.s))
    const save = el('button', 'review-btn primary', d.editing ? 'Save' : 'Add comment')
    save.addEventListener('click', () => this.saveDraft(view.s))
    const buttons = el('div', 'review-comment-btns')
    buttons.append(cancel, save)
    box.append(area, buttons)
    this.draftArea = area
    return box
  }

  private saveDraft(s: DocComments): void {
    const d = s.draft
    if (!d) return
    const text = d.text.trim()
    if (text === '') {
      this.cancelDraft(s)
      return
    }
    if (d.editing) {
      const c = s.comments.find((x) => x.id === d.editing)
      if (c) c.text = text
    } else {
      s.comments.push({ id: `d${nextId++}`, anchor: d.anchor, text, outdated: false })
    }
    s.draft = null
    // the comments changed: a refusal of the last Send is old news
    this.sendError = null
    this.redrawKept()
  }

  private cancelDraft(s: DocComments): void {
    s.draft = null
    this.redrawKept()
  }

  private renderComment(view: DocView, c: ReviewComment): HTMLElement {
    const box = el('div', `review-comment${c.outdated ? ' outdated' : ''}`)
    const meta = el('div', 'review-comment-meta', `${c.anchor.relPath} · ${describeLines(c.anchor)}`)
    if (c.outdated) meta.append(' · ', el('span', 'review-outdated', 'outdated'))
    const edit = el('button', 'review-link', 'Edit')
    edit.addEventListener('click', () => {
      view.s.draft = { anchor: c.anchor, text: c.text, editing: c.id }
      this.focusOnShow = true
      this.redrawKept()
    })
    const del = el('button', 'review-link', 'Delete')
    del.addEventListener('click', () => {
      view.s.comments = view.s.comments.filter((x) => x.id !== c.id)
      this.sendError = null
      this.redrawKept()
    })
    const buttons = el('div', 'review-comment-btns')
    buttons.append(edit, del)
    box.append(meta, el('div', 'review-comment-text', c.text), buttons)
    return box
  }

  /**
   * The footer of a Markdown document: its comment count, or the last Send error, and Send to Claude. It is in the page only
   * while it shows: the Changes panel's footer has the same classes, and the locators of its tests count every match.
   */
  private renderFooter(doc: DocInfo | null, s: DocComments | null): void {
    if (doc === null || s === null || doc.kind !== 'markdown') {
      this.footerEl.remove()
      return
    }
    if (!this.footerEl.isConnected) this.contentEl.after(this.footerEl)
    const n = s.comments.length
    this.countEl.textContent = this.sendError ?? `${n} comment${n === 1 ? '' : 's'}`
    this.countEl.classList.toggle('error', this.sendError !== null)
    this.sendBtn.disabled = n === 0 || this.sending
    this.sendBtn.title = this.sendError ?? ''
  }

  private async sendAll(): Promise<void> {
    const u = this.current
    const doc = this.selected()
    if (!u || !doc || doc.kind !== 'markdown' || this.sending) return
    const s = this.docState(u.tabId, doc.id)
    const sent = s.comments
    if (sent.length === 0) return
    this.sending = true
    this.sendError = null
    this.renderFooter(doc, s)
    let error: string | null
    // `sending` is shared by every tab: a failure must not leave Send disabled
    try {
      error = await attemptSend(() => this.cb.send(u.tabId, formatDocMessage(doc.relPath, sent)))
    } finally {
      this.sending = false
    }
    this.sendError = error
    if (error === null) {
      // the comments written while the message went stay; the ones sent are gone
      s.comments = withoutSent(s.comments, sent)
      s.draft = draftAfterSend(s.draft)
    }
    this.redrawKept()
  }

  private openMenu(): void {
    const doc = this.selected()
    if (!doc) return
    const r = this.moreBtn.getBoundingClientRect()
    showMenu({ x: r.left, y: r.bottom }, [
      { label: 'Open in default app', action: () => this.cb.action(doc.id, 'open') },
      { label: 'Show in Explorer', action: () => this.cb.action(doc.id, 'reveal') },
      { label: 'Copy path', action: () => this.cb.action(doc.id, 'copy-path') },
      { label: '', separator: true },
      { label: 'Remove from list', action: () => this.cb.action(doc.id, 'remove') }
    ])
  }
}
