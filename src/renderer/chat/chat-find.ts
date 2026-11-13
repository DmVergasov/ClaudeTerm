import type { ChatCard, ChatItem } from '../../shared/chat'
import type { FindTarget } from '../search'
import { chatMarkdownText } from './chat-markdown'
import { splitQuotes } from './chat-quote'
import { openForMatch } from './chat-steps'
import type { ChatView } from './chat-view'

/** the highlights of the page: every match in the drawn items, and the current one over them */
const ALL = 'chat-find'
const CURRENT = 'chat-find-current'
/** the most ranges the page highlights at once: a term that matches a whole table is cut to this many */
const MAX_HIGHLIGHTS = 1000

/** the match Find is on: its item, and the index of the match within the item's visible text */
interface Cursor { id: string; k: number }

/** the find that painted the page's highlights last: only it may delete them, so a chat in the background leaves them be */
let painter: ChatFind | null = null

/**
 * The text as Find compares it: lower case, character by character, so the offsets hold. A character whose lower case is
 * longer than itself keeps its case.
 */
function fold(s: string): string {
  const lower = s.toLowerCase()
  if (lower.length === s.length) return lower
  let out = ''
  for (const c of s) {
    const l = c.toLowerCase()
    out += l.length === c.length ? l : c
  }
  return out
}

function cardText(card: ChatCard): string {
  switch (card.type) {
    case 'permission': return `${card.title}\n${card.subject}`
    case 'question': {
      const first = card.questions[0]
      return first === undefined ? '' : [first.question, ...first.options.map((o) => o.label)].join('\n')
    }
    case 'plan': return card.plan
    case 'dialog': return `Dialog: ${card.kind}`
  }
}

/**
 * The text a user bubble draws: each quote as its text, without the `> ` it is written with, then the typed text, then the names of
 * the files that are not drawn as thumbnails. A bubble's picture with a Media card is a thumbnail, which shows no text.
 */
function bubbleText(item: Extract<ChatItem, { kind: 'user' }>, hasCard: (cardId: string | null) => boolean): string {
  const { quotes, rest } = splitQuotes(item.text)
  return [...quotes, rest, ...item.attachments.filter((a) => !(a.kind === 'image' && hasCard(a.cardId))).map((a) => a.name)].join('\n')
}

/** what an item shows as text when it is open: a step's tool names, subjects and outputs are text of the conversation, folded or not */
function searchText(item: ChatItem, hasCard: (cardId: string | null) => boolean): string {
  switch (item.kind) {
    case 'user': return bubbleText(item, hasCard)
    case 'text': return item.markdown
    // a step's rows draw the names, subjects, details and errors, and a Bash well draws its output: nothing else is text of it, and
    // the subagents are drawn in the dock above the composer, not in the step
    case 'tools': return item.calls.map((c) => [c.name, c.subject, c.detail, c.name === 'Bash' ? c.output : null, c.error]
      .filter((s): s is string => typeof s === 'string' && s !== '').join('\n')).join('\n')
    case 'command': return `${item.command}\n${item.output}`
    case 'notice': return item.text
    case 'divider': return item.text
    case 'reload': return `${item.title}\n${item.text}`
    // a row shows its title; its folded text is text of the conversation only when it is unfolded, as a thinking block's
    case 'event': return item.title
    case 'card': return item.answered ?? cardText(item.card)
    // a thinking block shows its summary when it is open, which is its start; a folded one draws no summary, and the search reads a drawn
    // item first, so the summary is not found then. An image shows no text.
    case 'thinking': return item.summary ?? ''
    case 'images': return ''
  }
}

/** the folded text of an item that does not change with the cards: cached by the item object, as a changed item is a new object */
const foldedTexts = new WeakMap<ChatItem, string>()
/** the folded Markdown source of a text item: a text whose source does not hold the term is not rendered to look for it */
const foldedSources = new WeakMap<ChatItem, string>()

/**
 * The text an item shows, as the search compares it. A text item is its Markdown as it renders; a user bubble is its text as drawn
 * (see bubbleText). A user bubble is not cached: whether its pictures are thumbnails changes with the cards.
 */
function shownText(item: ChatItem, caseSensitive: boolean, hasCard: (cardId: string | null) => boolean): string {
  if (item.kind === 'user') {
    const raw = bubbleText(item, hasCard)
    return caseSensitive ? raw : fold(raw)
  }
  const raw = item.kind === 'text' ? chatMarkdownText(item.markdown) : searchText(item, hasCard)
  if (caseSensitive) return raw
  let folded = foldedTexts.get(item)
  if (folded === undefined) {
    folded = fold(raw)
    foldedTexts.set(item, folded)
  }
  return folded
}

/** a text node that is shown in the window: it has a box, so no folded step or hidden element is above it */
const boxed = (el: Element): boolean => el.getClientRects().length > 0

/**
 * The ranges of the needle in a node's shown text, in reading order. `needle` is the term as the search compares it (folded
 * unless case-sensitive). Each element is asked whether it is shown once.
 */
function matchesIn(node: HTMLElement, needle: string, caseSensitive: boolean): Range[] {
  const parts: { text: Text; start: number }[] = []
  const shownBy = new Map<Element, boolean>()
  let text = ''
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const t = n as Text
    if (t.data === '' || t.parentElement === null) continue
    let shown = shownBy.get(t.parentElement)
    if (shown === undefined) {
      shown = boxed(t.parentElement)
      shownBy.set(t.parentElement, shown)
    }
    if (!shown) continue
    parts.push({ text: t, start: text.length })
    text += t.data
  }
  const haystack = caseSensitive ? text : fold(text)
  const ranges: Range[] = []
  if (needle === '') return ranges
  // the part that holds an offset: the offsets of the matches only grow, so the part only moves on
  let k = 0
  const at = (offset: number): [Text, number] => {
    while (k + 1 < parts.length && parts[k + 1]!.start <= offset) k++
    return [parts[k]!.text, offset - parts[k]!.start]
  }
  for (let start = haystack.indexOf(needle); start !== -1; start = haystack.indexOf(needle, start + needle.length)) {
    const [startNode, startOffset] = at(start)
    const [endNode, endOffset] = at(start + needle.length - 1)
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset + 1)
    ranges.push(range)
  }
  return ranges
}

/** the current match is in a Bash well: the well scrolls to it, so the match is in its box */
function showInWell(range: Range): void {
  const pre = range.startContainer.parentElement?.closest<HTMLElement>('.chat-well-text')
  if (!pre) return
  const box = range.getBoundingClientRect()
  const frame = pre.getBoundingClientRect()
  if (box.top < frame.top || box.bottom > frame.bottom) pre.scrollTop += box.top - frame.top - frame.height / 2
}

/**
 * Find in a chat. The matches are searched in the view's items, the text each one shows; the items in the window are
 * highlighted with CSS highlights. The search starts at the newest message and goes back: Enter takes the next older match,
 * Shift+Enter the newer one. Only Enter asks for older pages, one at a time: the search as the term is typed looks at the held
 * items. Going back past the oldest held item, a page before it is asked for, and the search goes on.
 */
export class ChatFind implements FindTarget {
  /** the search bar searches as the term is typed: the first match is taken then, and Enter takes the next */
  readonly searchAsYouType = true
  private term = ''
  private caseSensitive = false
  /** the term as the search compares it: folded once per search, unless case-sensitive */
  private needle = ''
  private cursor: Cursor | null = null
  /** a search's generation: a walk for older pages stops when a newer search or a close has started */
  private gen = 0

  constructor(private readonly view: ChatView) {}

  findNext(term: string, opts?: { caseSensitive?: boolean; incremental?: boolean }): boolean {
    return this.find(term, opts?.caseSensitive === true, true, opts?.incremental === true)
  }

  findPrevious(term: string, opts?: { caseSensitive?: boolean }): boolean {
    return this.find(term, opts?.caseSensitive === true, false, false)
  }

  clearDecorations(): void {
    this.gen++
    this.cursor = null
    this.term = ''
    this.needle = ''
    // the page's highlights go only with the find that set them: another chat's clearing leaves the chat in front its own
    if (painter === this) {
      CSS.highlights.delete(ALL)
      CSS.highlights.delete(CURRENT)
      painter = null
    }
  }

  private find(term: string, caseSensitive: boolean, back: boolean, typing: boolean): boolean {
    if (term === '') {
      this.clearDecorations()
      return false
    }
    const same = term === this.term && caseSensitive === this.caseSensitive
    // as the term is typed, the same term keeps its match: a letter typed and taken back does not move the search on
    if (typing && same && this.cursor !== null) {
      this.paint()
      return true
    }
    // a new term starts from the newest message, and a walk for the old term is dropped
    if (!same) {
      this.gen++
      this.cursor = null
      this.term = term
      this.caseSensitive = caseSensitive
      this.needle = caseSensitive ? term : fold(term)
    }
    return this.go(back, !typing)
  }

  /** the next match from the current one: a later match in the same item first, then the items */
  private go(back: boolean, pull: boolean): boolean {
    const gen = ++this.gen
    const cursor = this.cursor
    // a fresh search starts at the newest message, whichever way it goes
    if (cursor === null) return this.scan(gen, null, true, false, pull, null)
    const node = this.view.drawnNode(cursor.id)
    if (node !== null) {
      const k = cursor.k + (back ? -1 : 1)
      if (k >= 0 && k < matchesIn(node, this.needle, this.caseSensitive).length) {
        this.cursor = { id: cursor.id, k }
        this.view.reveal(cursor.id)
        this.paint()
        return true
      }
    }
    return this.scan(gen, cursor.id, back, false, pull, cursor.id)
  }

  /**
   * The held items from `fromId` (exclusive; null: from the newest, or the oldest when going forward) in the direction. Going
   * back past the oldest held item asks for its page first, when the search may pull and the chat is shown. A walk that started
   * at a match wraps once to the other end and stops at that match (`origin`), so a term with no match scans each item once.
   */
  private scan(gen: number, fromId: string | null, back: boolean, wrapped: boolean, pull: boolean, origin: string | null): boolean {
    const count = this.view.itemCount()
    let limit = back ? 0 : count - 1
    if (wrapped && origin !== null) {
      const at = this.view.indexOfItem(origin)
      if (at >= 0) limit = at
    }
    let i = back ? count - 1 : 0
    if (fromId !== null) {
      const at = this.view.indexOfItem(fromId)
      if (at >= 0) i = at + (back ? -1 : 1)
    }
    for (; back ? i >= limit : i <= limit; i += back ? -1 : 1) {
      const item = this.view.itemAt(i)
      if (item !== undefined && this.holds(item) && this.land(item.id, back)) return true
    }
    const oldest = this.view.itemAt(0)
    if (back && pull && !wrapped && this.view.isShown() && this.view.hasOlderItems() && oldest !== undefined) {
      void this.view.loadOlder().then((added) => {
        if (gen !== this.gen) return
        if (added) this.scan(gen, oldest.id, back, wrapped, pull, origin)
        else this.end(gen, back, wrapped, pull, origin)
      })
      return true
    }
    return this.end(gen, back, wrapped, pull, origin)
  }

  /** nothing before the end of the held items: a walk that started at a match wraps to the other end, up to it; then there is no match */
  private end(gen: number, back: boolean, wrapped: boolean, pull: boolean, origin: string | null): boolean {
    if (!wrapped && origin !== null) return this.scan(gen, null, back, true, pull, origin)
    this.paint()
    return false
  }

  /**
   * An item may hold a match: a drawn one by the matches it shows, and a step by its text too, since a match in its folded
   * rows or wells opens it. An undrawn one by the text it shows, so an item that holds no match is not drawn.
   */
  private holds(item: ChatItem): boolean {
    const node = this.view.drawnNode(item.id)
    if (node !== null && matchesIn(node, this.needle, this.caseSensitive).length > 0) return true
    if (node !== null && item.kind !== 'tools') return false
    if (node === null && item.kind === 'text' && !this.sourceHolds(item)) return false
    return this.shownTextOf(item).includes(this.needle)
  }

  /** a text's Markdown source holds the term, folded as the search compares; cached by the item object */
  private sourceHolds(item: Extract<ChatItem, { kind: 'text' }>): boolean {
    if (this.caseSensitive) return item.markdown.includes(this.needle)
    let folded = foldedSources.get(item)
    if (folded === undefined) {
      folded = fold(item.markdown)
      foldedSources.set(item, folded)
    }
    return folded.includes(this.needle)
  }

  private shownTextOf(item: ChatItem): string {
    return shownText(item, this.caseSensitive, (cardId) => this.view.hasCard(cardId))
  }

  /**
   * The item comes into the view with its match: its last match going back, its first going on. A match in a folded step opens
   * the step, as the user would open it, and the Bash wells that hold the term show whole.
   */
  private land(id: string, back: boolean): boolean {
    this.view.reveal(id)
    const node = this.view.drawnNode(id)
    if (node === null) return false
    let ranges = matchesIn(node, this.needle, this.caseSensitive)
    const item = this.view.itemAt(this.view.indexOfItem(id))
    let undo: (() => void) | null = null
    if (ranges.length === 0 && item?.kind === 'tools' && node.classList.contains('chat-steps') && this.shownTextOf(item).includes(this.needle)) {
      undo = openForMatch(node, (text) => (this.caseSensitive ? text : fold(text)).includes(this.needle))
      ranges = matchesIn(node, this.needle, this.caseSensitive)
    }
    if (ranges.length === 0) {
      // a step the match does not show after all is left as it was
      undo?.()
      return false
    }
    // the opened step may have moved the match below the view: the column is brought to the item again
    if (undo !== null) this.view.reveal(id)
    this.cursor = { id, k: back ? ranges.length - 1 : 0 }
    this.paint()
    return true
  }

  /**
   * The highlights as the drawn items show them now: the matches, at most MAX_HIGHLIGHTS of them with the current one among
   * them, and the current one on its own. This find is then the painter.
   */
  private paint(): void {
    const all: Range[] = []
    let current: Range | null = null
    for (const node of this.view.drawnNodes()) {
      const isCursor = this.cursor !== null && node.dataset.item === this.cursor.id
      // past the cap the other items are not searched for ranges: only the current one's are needed
      if (all.length >= MAX_HIGHLIGHTS && !isCursor) continue
      const ranges = matchesIn(node, this.needle, this.caseSensitive)
      if (isCursor) current = ranges[this.cursor!.k] ?? null
      for (const range of ranges) {
        if (all.length >= MAX_HIGHLIGHTS) break
        all.push(range)
      }
    }
    if (current !== null && !all.includes(current)) {
      all.length = Math.min(all.length, MAX_HIGHLIGHTS - 1)
      all.push(current)
    }
    if (all.length === 0) {
      CSS.highlights.delete(ALL)
    } else {
      const highlight = new Highlight()
      for (const range of all) highlight.add(range)
      CSS.highlights.set(ALL, highlight)
    }
    if (current === null) {
      CSS.highlights.delete(CURRENT)
    } else {
      CSS.highlights.set(CURRENT, new Highlight(current))
      showInWell(current)
    }
    painter = this
  }
}
