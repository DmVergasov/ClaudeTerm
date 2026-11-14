import type { ChatItem } from '../../shared/chat'
import type { ItemCallbacks } from './chat-items'
import { streamText } from './chat-items'
import { stepKeep, updateSteps, type StepKeep } from './chat-steps'

// The drawing that the chat's column (ChatView) and an agent's column (AgentColumn) share: an item is drawn in place where its node
// is (a streaming text grows, a tool step is updated), else whole; the choices a step or a thinking block made are kept by the item's
// id; the drawings queue for the next animation frame. The window over a long column (the items drawn, the pages before and after
// them) and the older pages are shared too: both columns move them the same way.

/** a queued drawing that no animation frame has taken by then is drawn by a timer: a window behind another window gets no frame */
const FRAME_FALLBACK_MS = 100

/** closer than this to either end of the view, the items beyond that end are drawn (the window moves) */
export const EDGE_ZONE = 400
/** the most items a column holds in the DOM at once */
export const WINDOW = 120
/** the items the window moves by, at a time */
export const PAGE_STEP = 60
/** a pixel of slack when deciding the column is at its bottom */
export const BOTTOM_SLACK = 24

/** the items drawn: items[from] to items[to - 1]; the others are held only */
export interface Win { from: number; to: number }

/** the window of the newest items: the column's end */
export function tailWin(count: number): Win {
  return { from: Math.max(0, count - WINDOW), to: count }
}

/** the window of the items around the one at `index`: a page above it, and the rest below */
export function windowAt(count: number, index: number): Win {
  const from = Math.max(0, index - PAGE_STEP)
  return { from, to: Math.min(count, from + WINDOW) }
}

/** the window that brings the item at `index` into the view with its neighbours: Find's current match */
export function revealWin(count: number, index: number): Win {
  const from = Math.max(0, Math.min(index - WINDOW / 2, count - WINDOW))
  return { from, to: Math.min(count, from + WINDOW) }
}

/** the window after a page up: it moves up by a page, toward the oldest items */
export function pageUpWin(w: Win): Win {
  const from = Math.max(0, w.from - PAGE_STEP)
  return { from, to: Math.min(w.to, from + WINDOW) }
}

/** the window after a page down: it moves down by a page, toward the newest items */
export function pageDownWin(w: Win, count: number): Win {
  const to = Math.min(count, w.to + PAGE_STEP)
  return { from: Math.max(w.from, to - WINDOW), to }
}

/**
 * A window change at the top of the scroll area: the browser does not keep the item at the very top in place, so that item is
 * held here, or the view would stay at the top with nothing left to scroll to. `change` moves the window and draws it.
 */
export function pageUpInView(scroll: HTMLElement, column: HTMLElement, change: () => void): void {
  const atTop = scroll.scrollTop === 0 ? column.firstElementChild : null
  const before = atTop?.getBoundingClientRect().top
  change()
  if (atTop !== null && before !== undefined && atTop.isConnected) {
    scroll.scrollTop += atTop.getBoundingClientRect().top - before
  }
}

/**
 * The items a snapshot brings into a column that holds items: the held items before the snapshot's first item stay (the pages the
 * reader paged in), and the snapshot's items come after them. `at` is the held index of the snapshot's first item, -1 when it is not
 * held (a reset, another conversation): then the snapshot's items replace the held ones.
 */
export function joinSnapshot(held: readonly ChatItem[], snapshot: readonly ChatItem[]): { items: ChatItem[]; at: number } {
  const first = snapshot[0]
  let at = -1
  if (first !== undefined) for (let i = held.length - 1; i >= 0; i--) if (held[i]!.id === first.id) { at = i; break }
  return { items: [...(at < 0 ? [] : held.slice(0, at)), ...snapshot], at }
}

/** the first item drawn that is at least partly in view, and its top's offset from the top of the view */
export function topItemOf(scroll: HTMLElement, column: HTMLElement): { id: string; offset: number } | null {
  const top = scroll.getBoundingClientRect().top
  for (const node of Array.from(column.children)) {
    if (!(node instanceof HTMLElement) || node.dataset.item === undefined) continue
    const box = node.getBoundingClientRect()
    if (box.bottom > top) return { id: node.dataset.item, offset: box.top - top }
  }
  return null
}

/** the item the reader was on stays at the same offset from the top of the view */
export function keepAtNode(scroll: HTMLElement, node: HTMLElement, anchor: { offset: number }): void {
  const top = scroll.getBoundingClientRect().top
  scroll.scrollTop += node.getBoundingClientRect().top - top - anchor.offset
}

/** the view scrolls so that the node is at its middle */
export function scrollToMiddle(scroll: HTMLElement, node: HTMLElement): void {
  const frame = scroll.getBoundingClientRect()
  const box = node.getBoundingClientRect()
  scroll.scrollTop += box.top + box.height / 2 - (frame.top + scroll.clientHeight / 2)
}

/** an older page: the items before the ones held, and whether items are still before them */
export interface OlderPage { items: ChatItem[]; hasOlder: boolean }

/**
 * The older pages of a column, asked for one at a time. The owner answers `ask`; an answer is taken only while its item is still the
 * first one held, and `take` puts its items above the window. At the top of the held items the page before the first is asked for,
 * once; an empty or dropped answer is asked again once while the view is still at the top, and a refusal is not asked again by itself.
 */
export class OlderPages {
  /** whether items older than the ones held are on the owner's side */
  hasOlder = false
  /** a page is being asked for: one request at a time, until its answer comes */
  private asked: Promise<{ count: number } | null> | null = null

  constructor(private readonly o: {
    ask(beforeId: string): Promise<OlderPage | null>
    first(): ChatItem | undefined
    /** the page goes in above the window */
    take(items: ChatItem[]): void
    /** the column is drawn: an answer is acted on only then */
    ready(): boolean
    nearTop(): boolean
    /** the window moves up into the page taken */
    grow(): void
  }) {}

  /** the window is at the top of the held items: the page before the first one is asked for, once */
  askFirst(): void {
    const first = this.o.first()
    if (this.hasOlder && this.asked === null && first !== undefined) this.ask(first.id)
  }

  /** asks for the page before the first item held: resolves to whether items came in above the window */
  load(): Promise<boolean> {
    const counted = (a: { count: number } | null): boolean => a !== null && a.count > 0
    if (this.asked !== null) return this.asked.then(counted, () => false)
    const first = this.o.first()
    if (!this.hasOlder || first === undefined) return Promise.resolve(false)
    return this.fetch(first.id).then(counted, () => false)
  }

  private ask(beforeId: string, again = true): void {
    this.fetch(beforeId).then(
      (taken) => {
        if (!this.o.ready() || !this.o.nearTop()) return
        if (taken !== null && taken.count > 0) this.o.grow()
        else if (again && this.hasOlder && this.o.first() !== undefined) this.ask(this.o.first()!.id, false)
      },
      // a refused request is not asked again by itself
      () => undefined
    )
  }

  /** the page before `beforeId`: the count taken, or null when nothing was taken; a refusal rejects */
  private fetch(beforeId: string): Promise<{ count: number } | null> {
    const asked = this.o.ask(beforeId).then(
      (page) => {
        this.asked = null
        if (page === null || this.o.first()?.id !== beforeId) return null
        this.hasOlder = page.hasOlder
        if (page.items.length > 0) this.o.take(page.items)
        return { count: page.items.length }
      },
      (e: unknown) => {
        this.asked = null
        throw e
      }
    )
    this.asked = asked
    return asked
  }
}

/** the choices of a tool step or a thinking block, as its node shows them, are kept by the item's id when the node goes */
export function keepFold(folds: Map<string, StepKeep>, id: string, node: HTMLElement): void {
  if (node.classList.contains('chat-thinking')) {
    // open is a thinking block's default: only the user's fold is kept
    if (node.querySelector('.chat-thinking-head[aria-expanded="false"]') !== null) folds.set(id, { open: false, wells: [] })
    else folds.delete(id)
    return
  }
  if (!node.classList.contains('chat-steps')) return
  const keep = stepKeep(node)
  if (keep.open !== null || keep.wells.length > 0) folds.set(id, keep)
  else folds.delete(id)
}

/**
 * Whether the step with `id` is settled: an item follows it (the images items that follow a step do not count), or the turn is over
 * (`over`). Until then its card stays open.
 */
export function settledAfter(items: readonly ChatItem[], id: string, over: boolean): boolean {
  if (over) return true
  let i = items.length - 1
  while (i >= 0 && items[i]!.id !== id) i--
  if (i < 0) return true
  let j = i + 1
  while (j < items.length && items[j]!.kind === 'images') j++
  return j < items.length
}

/** the tool step before the item at `end` (exclusive), the images items between not counting: it is the one an item that comes in can settle */
export function stepBefore(items: readonly ChatItem[], end: number): ChatItem | null {
  let i = end - 1
  while (i >= 0 && items[i]!.kind === 'images') i--
  const item = items[i]
  return item?.kind === 'tools' ? item : null
}

/**
 * An item as the model has it now, drawn in place where its node is: a streaming text grows in place (only its tail is drawn again),
 * a tool step is updated where it is; anything else is painted whole by `paint`.
 */
export function drawInPlace(item: ChatItem, node: HTMLElement, cb: ItemCallbacks, paint: () => void): void {
  if (item.kind === 'text' && item.streaming && node.classList.contains('streaming')) {
    streamText(node, item.markdown)
    return
  }
  if (item.kind === 'tools' && node.classList.contains('chat-steps')) {
    updateSteps(node, item, cb)
    return
  }
  paint()
}

/** a call's patch: a tool step's row is filled where it is, the rest of the step left as it is; anything else is drawn in place by `whole` */
export function drawCallInPlace(item: ChatItem, node: HTMLElement, callId: string, cb: ItemCallbacks, whole: () => void): void {
  if (item.kind === 'tools' && node.classList.contains('chat-steps')) updateSteps(node, item, cb, callId)
  else whole()
}

/** an item drawn on its own: one that throws leaves an empty node in its place, so the rest of the column is still drawn */
export function drawSafely(item: ChatItem, draw: (item: ChatItem) => HTMLElement, label: string): HTMLElement {
  try {
    return draw(item)
  } catch (e) {
    console.error(`${label}: drawing ${item.id} failed`, e)
    const node = document.createElement('div')
    node.dataset.item = item.id
    return node
  }
}

/**
 * The drawings queued for the next animation frame: a drawing queued under a key again is done once, in its first place. A frame that
 * does not come is backed by a timer. `ready` says whether drawing is due now (a hidden column draws nothing); `begin` runs first in a
 * flush, `end` after the queued drawings.
 */
export class FrameQueue {
  private queued = new Map<string, () => void>()
  private frame: { raf: number; timer: ReturnType<typeof setTimeout> } | null = null

  constructor(private readonly o: { ready(): boolean; label: string; begin(): void; end(): void }) {}

  add(key: string, op: () => void): void {
    if (!this.o.ready()) return
    this.queued.set(key, op)
    this.request()
  }

  /** a flush is due: the queue is drawn at the next frame, or by the timer when no frame comes */
  request(): void {
    if (!this.o.ready() || this.frame !== null) return
    this.frame = {
      raf: requestAnimationFrame(() => this.flush()),
      timer: setTimeout(() => this.flush(), FRAME_FALLBACK_MS)
    }
  }

  /** the drawings queued are dropped: what they would draw is drawn again by the caller */
  drop(): void {
    this.cancel()
    this.queued.clear()
  }

  private flush(): void {
    this.cancel()
    this.o.begin()
    const ops = [...this.queued.entries()]
    this.queued.clear()
    for (const [key, op] of ops) {
      // one drawing that throws does not lose the rest of the batch
      try {
        op()
      } catch (e) {
        console.error(`${this.o.label}: drawing ${key} failed`, e)
      }
    }
    this.o.end()
  }

  private cancel(): void {
    if (this.frame === null) return
    cancelAnimationFrame(this.frame.raf)
    clearTimeout(this.frame.timer)
    this.frame = null
  }
}
