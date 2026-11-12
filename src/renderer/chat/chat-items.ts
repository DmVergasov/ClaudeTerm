import type { ChatAnswer, ChatAttachment, ChatItem } from '../../shared/chat'
import { icon } from '../icons'
import type { ImageCard } from '../../shared/types'
import { imageUrl } from '../image-url'
import { chatMarkdownHtml, markdownClick, splitStable } from './chat-markdown'
import { renderCard } from './chat-cards'
import { renderImages, renderSteps, type StepKeep } from './chat-steps'

export interface ItemCallbacks {
  answer(cardId: string, a: ChatAnswer): void | Promise<boolean>
  restart(): void
  /** a notice's line goes to the terminal, typed there; null: a dialog the chat cannot show, the terminal only is switched to */
  openInTerminal(line: string | null): void
  /** the Media card of an image, from the tab's last images update; null when the panel has no such card */
  imageCard(cardId: string): ImageCard | null
  openImages(cards: ImageCard[], index: number): void
  revealChange(path: string): void
  /** an http(s) address Claude wrote, opened in the browser */
  openExternal(url: string): void
  copy(text: string): void
}

const el = (tag: string, className: string, text = ''): HTMLElement => {
  const e = document.createElement(tag)
  e.className = className
  e.textContent = text
  return e
}

const button = (label: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', 'chat-button', label) as HTMLButtonElement
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

/** how many blocks of a streaming text are drawn already: the stable part only grows, a block is drawn once */
const drawnStable = new WeakMap<HTMLElement, number>()

/** one item of the column, drawn plainly: the text is always set as text, never as markup, except Claude's Markdown */
export function renderItem(item: ChatItem, cb: ItemCallbacks, keep: StepKeep | null = null, settled = true): HTMLElement {
  switch (item.kind) {
    case 'user': return userItem(item, cb)
    case 'text': return textNode(item, cb)
    case 'tools': return renderSteps(item, cb, keep, settled)
    case 'notice': return noticeItem(item.tone, item.text, item.action, item.line ?? null, cb)
    case 'divider': return el('div', 'chat-divider', item.text)
    case 'card': return renderCard(item, cb)
    case 'thinking': return thinkingItem(item.ms, item.summary, keep?.open === true)
    case 'images': return renderImages(item, cb)
    case 'command': return commandItem(item.command, item.output)
  }
}

/**
 * Claude's text as Markdown. A streaming text is drawn in parts: each block of its stable part once, then only its tail
 * again (see streamText). Clicks inside it: a web link opens in the browser, every link is kept from navigating, and a
 * Copy button copies its block's code.
 */
function textNode(item: Extract<ChatItem, { kind: 'text' }>, cb: ItemCallbacks): HTMLElement {
  const node = el('div', 'chat-text')
  node.addEventListener('click', (e) => markdownClick(e, cb))
  if (item.streaming) {
    node.classList.add('streaming')
    node.append(el('div', 'chat-tail'))
    streamText(node, item.markdown)
  } else {
    node.innerHTML = chatMarkdownHtml(item.markdown)
  }
  return node
}

/**
 * Draws a streaming text: the blocks of its stable part that are not drawn yet go in before the tail, then the tail is drawn
 * again. The node is the one textNode made.
 */
export function streamText(node: HTMLElement, markdown: string): void {
  const { stable, tail } = splitStable(markdown)
  const done = drawnStable.get(node) ?? 0
  const tailNode = node.querySelector<HTMLElement>(':scope > .chat-tail')
  if (!tailNode) return
  if (stable.length > done) {
    const part = el('div', 'chat-part')
    part.innerHTML = chatMarkdownHtml(stable.slice(done))
    node.insertBefore(part, tailNode)
    drawnStable.set(node, stable.length)
  }
  tailNode.innerHTML = chatMarkdownHtml(tail)
}

function userItem(item: Extract<ChatItem, { kind: 'user' }>, cb: ItemCallbacks): HTMLElement {
  const row = el('div', `chat-item chat-user-row${item.queued ? ' queued' : ''}`)
  if (item.text !== '') row.append(el('div', 'chat-user', item.text))
  if (item.attachments.length > 0) row.append(attachments(item.attachments, cb))
  if (item.queued) row.append(el('div', 'chat-quiet', 'Queued'))
  return row
}

/** the files of a message: an image with its Media card shows as a thumbnail, anything else as a chip with its name */
function attachments(list: ChatAttachment[], cb: ItemCallbacks): HTMLElement {
  const box = el('div', 'chat-attachments')
  for (const a of list) {
    const card = a.kind === 'image' && a.cardId !== null ? cb.imageCard(a.cardId) : null
    if (card === null) {
      const chip = el('span', 'chat-chip')
      chip.innerHTML = icon(a.kind === 'image' ? 'image' : 'note', 14)
      chip.append(el('span', 'chat-chip-name', a.name))
      box.append(chip)
      continue
    }
    const thumb = document.createElement('button')
    thumb.type = 'button'
    thumb.className = 'chat-thumb'
    thumb.title = card.name
    const img = document.createElement('img')
    img.src = imageUrl(card)
    img.alt = card.name
    thumb.append(img)
    thumb.addEventListener('click', () => cb.openImages([card], 0))
    box.append(thumb)
  }
  return box
}

/**
 * Claude's thinking: one folded row that unfolds to the summary as text. A thinking block with no summary draws no row, but an
 * element stays in its place, so the column's indexes and paging do not move; `open` is the user's kept choice
 */
function thinkingItem(ms: number | null, summary: string | null, open: boolean): HTMLElement {
  if (summary === null) return el('div', 'chat-thinking-none')
  const box = el('div', 'chat-thinking')
  const head = el('button', 'chat-thinking-head', ms === null ? 'Thought' : `Thought for ${Math.max(1, Math.round(ms / 1000))}s`) as HTMLButtonElement
  head.type = 'button'
  head.setAttribute('aria-expanded', 'false')
  box.append(head)
  let body: HTMLElement | null = null
  const unfold = (): void => {
    body = el('div', 'chat-thinking-body', summary)
    box.append(body)
    head.setAttribute('aria-expanded', 'true')
  }
  head.addEventListener('click', () => {
    if (body) {
      body.remove()
      body = null
      head.setAttribute('aria-expanded', 'false')
    } else {
      unfold()
    }
  })
  if (open) unfold()
  return box
}

/** a local command's answer (/context): a quiet block, its output scrolls once it is tall */
function commandItem(command: string, output: string): HTMLElement {
  const box = el('div', 'chat-command')
  box.append(el('div', 'chat-command-head', command), el('pre', 'chat-command-output', output))
  return box
}

function noticeItem(tone: 'info' | 'error', text: string, action: 'restart' | 'open-terminal' | null, line: string | null, cb: ItemCallbacks): HTMLElement {
  const row = el('div', `chat-notice ${tone}`)
  row.append(el('span', 'chat-notice-text', text))
  if (action === 'restart') row.append(button('Restart', () => cb.restart()))
  // a notice with a line types it in the terminal; one without only switches to the terminal. Both run as the composer runs a command.
  if (action === 'open-terminal') row.append(button('Open in the terminal', () => cb.openInTerminal(line ?? null)))
  return row
}
