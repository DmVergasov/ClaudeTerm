import { type ChatAnswer, type ChatAttachment, type ChatEventSource, type ChatItem, type ChatNoticeAction, isAgentId } from '../../shared/chat'
import type { ReloadAction } from '../../shared/mcp'
import { icon } from '../icons'
import type { ImageCard } from '../../shared/types'
import { imageUrl } from '../image-url'
import { chatMarkdownHtml, markdownClick, splitStable } from './chat-markdown'
import { renderCard } from './chat-cards'
import { renderImages, renderSteps, type StepKeep } from './chat-steps'
import { splitQuotes } from './chat-quote'
import { forwardMark } from './agent-text'

export interface ItemCallbacks {
  answer(cardId: string, a: ChatAnswer): void | Promise<boolean>
  restart(): void
  /** a notice's line goes to the terminal, typed there; null: a dialog the chat cannot show, the terminal only is switched to */
  openInTerminal(line: string | null): void
  /** a notice's MCP servers button: the panel opens on the servers */
  openMcp(): void
  /** the reload card's buttons: Not now keeps the card, Restart restarts the chat; null: the card has no buttons (a remote chat) */
  reload: ((action: ReloadAction) => void) | null
  /** the Media card of an image, from the tab's last images update; null when the panel has no such card */
  imageCard(cardId: string): ImageCard | null
  openImages(cards: ImageCard[], index: number): void
  /** an agent's row in the dock: its page opens in place of the conversation */
  openAgent(agentId: string): void
  revealChange(path: string): void
  /** an http(s) address Claude wrote, opened in the browser */
  openExternal(url: string): void
  /** a file link Claude wrote, opened by main: a document in Docs, anything else in the editor at its line (null: no line) */
  openFile(file: string, line: number | null): void
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

/** a prompt's fold as its column keeps it: unfolded is whether Show all was clicked, and unfold() keeps that for the item's redraws */
export interface PromptFold { unfolded: boolean; unfold(): void }

/** one item of the column, drawn plainly: the text is always set as text, never as markup, except Claude's Markdown */
export function renderItem(item: ChatItem, cb: ItemCallbacks, keep: StepKeep | null = null, settled = true, prompt: PromptFold = { unfolded: false, unfold: () => undefined }): HTMLElement {
  switch (item.kind) {
    case 'user': return userItem(item, cb)
    case 'text': return textNode(item, cb)
    case 'tools': return renderSteps(item, cb, keep, settled)
    case 'notice': return noticeItem(item.tone, item.text, item.action, item.line ?? null, cb)
    case 'divider': return dividerItem(item.text, item.good ?? null)
    case 'reload': return reloadItem(item, cb)
    case 'card': return renderCard(item, cb)
    case 'thinking': return thinkingItem(item.ms, item.summary, keep?.open !== false)
    case 'images': return renderImages(item, cb)
    case 'command': return commandItem(item.command, item.output)
    case 'event': return eventItem(item.source, item.title, item.status, item.body)
    case 'prompt': return promptItem(item, cb, prompt)
    case 'forward': return forwardNote(item, cb)
  }
}

/** a prompt longer than this many lines or characters is folded to six lines, with Show all */
const PROMPT_FOLD_LINES = 6
const PROMPT_FOLD_CHARS = 600

/**
 * A prompt on an agent's page: what Claude asked the agent (its first, "Claude asked") or a later message from Claude ("From Claude").
 * A quiet block with its text as Markdown; a long one is folded, and Show all unfolds it, for good as the column keeps it.
 */
function promptItem(item: Extract<ChatItem, { kind: 'prompt' }>, cb: ItemCallbacks, fold: PromptFold): HTMLElement {
  const box = el('div', 'chat-prompt')
  box.append(el('div', 'chat-prompt-head', item.first ? 'Claude asked' : 'From Claude'))
  const body = el('div', 'chat-prompt-body')
  body.innerHTML = chatMarkdownHtml(item.text)
  body.addEventListener('click', (e) => markdownClick(e, cb))
  box.append(body)
  if ((item.text.split('\n').length > PROMPT_FOLD_LINES || item.text.length > PROMPT_FOLD_CHARS) && !fold.unfolded) {
    body.classList.add('folded')
    const more = el('button', 'chat-prompt-more', 'Show all') as HTMLButtonElement
    more.type = 'button'
    more.addEventListener('click', () => {
      body.classList.remove('folded')
      more.remove()
      fold.unfold()
    })
    box.append(more)
  }
  return box
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
    node.innerHTML = chatMarkdownHtml(item.markdown, { paths: true })
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
    part.innerHTML = chatMarkdownHtml(stable.slice(done), { paths: true })
    node.insertBefore(part, tailNode)
    drawnStable.set(node, stable.length)
  }
  tailNode.innerHTML = chatMarkdownHtml(tail, { paths: true })
}

function userItem(item: Extract<ChatItem, { kind: 'user' }>, cb: ItemCallbacks): HTMLElement {
  const row = el('div', `chat-item chat-user-row${item.queued ? ' queued' : ''}`)
  if (item.text !== '') row.append(userBubble(item.text))
  if (item.attachments.length > 0) row.append(attachments(item.attachments, cb))
  if (item.queued) row.append(el('div', 'chat-quiet', 'Queued'))
  return row
}

/** a message's bubble: the quotes it starts with are blocks above its text; a message with no leading quote is its text */
function userBubble(text: string): HTMLElement {
  const { quotes, rest } = splitQuotes(text)
  const bubble = el('div', 'chat-user')
  for (const quote of quotes) bubble.append(el('div', 'chat-quote-block', quote))
  if (rest !== '') bubble.append(rest)
  return bubble
}

/**
 * A forward in the main conversation: one quiet line, `↗ To <label>: <first line of its text>`, then its mark. A click opens the
 * agent's page, for an id that is an agent id.
 */
function forwardNote(item: Extract<ChatItem, { kind: 'forward' }>, cb: ItemCallbacks): HTMLElement {
  const row = el('div', 'chat-forward')
  row.append(el('span', 'chat-forward-line', `↗ To ${item.label}: ${item.text.split('\n')[0]}`), forwardMarkNode(item))
  if (isAgentId(item.agentId)) {
    row.classList.add('open')
    // a button for the keyboard, as the step rows are: Enter and Space open the page, as a click does
    row.tabIndex = 0
    row.setAttribute('role', 'button')
    const open = (): void => cb.openAgent(item.agentId)
    row.addEventListener('click', open)
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      open()
    })
  }
  return row
}

/**
 * A forward on an agent's page: the person's message as a bubble, and under it its mark (how it goes through Claude). The page
 * draws it; the main conversation draws a note (forwardNote).
 */
export function forwardBubble(item: Extract<ChatItem, { kind: 'forward' }>): HTMLElement {
  const row = el('div', 'chat-item chat-user-row forward')
  row.append(userBubble(item.text), forwardMarkNode(item))
  return row
}

/** a forward's mark: its state as the text says it, in the error tone when Claude did not send it */
function forwardMarkNode(item: Extract<ChatItem, { kind: 'forward' }>): HTMLElement {
  return el('span', item.state === 'failed' ? 'agent-mark error' : 'agent-mark', forwardMark(item.state, item.reason))
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
 * Claude's thinking: a row with the summary as text under it, open from the start; a click folds it to the row. A thinking block
 * with no summary draws no row, but an element stays in its place, so the column's indexes and paging do not move; `open` is
 * false only when the user folded it
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

/**
 * A message Claude Code put in the conversation that is not the person's: a compact muted row with its title (and its status
 * when it is not completed); its text is folded under it and unfolds on a click. The text is set as text, never as markup.
 */
function eventItem(source: ChatEventSource, title: string, status: string | null, body: string): HTMLElement {
  const failed = status === 'failed' || status === 'stopped'
  const row = el('div', `chat-item chat-event ${source}${failed ? ' failed' : ''}`)
  const head = el(body === '' ? 'div' : 'button', 'chat-event-head')
  if (head instanceof HTMLButtonElement) {
    head.type = 'button'
    head.setAttribute('aria-expanded', 'false')
  }
  const mark = el('span', 'chat-event-icon')
  mark.innerHTML = icon(source === 'task' ? (failed ? 'x' : 'check') : source === 'peer' ? 'message-square' : 'mail', 14)
  head.append(mark, el('span', 'chat-event-title', title))
  if (status !== null) head.append(el('span', 'chat-event-status', status))
  row.append(head)
  if (body === '') return row
  let text: HTMLElement | null = null
  head.addEventListener('click', () => {
    if (text !== null) {
      text.remove()
      text = null
      head.setAttribute('aria-expanded', 'false')
    } else {
      text = el('div', 'chat-event-body', body)
      row.append(text)
      head.setAttribute('aria-expanded', 'true')
    }
  })
  return row
}

/** a local command's answer (/context): a quiet block, its output scrolls once it is tall */
function commandItem(command: string, output: string): HTMLElement {
  const box = el('div', 'chat-command')
  box.append(el('div', 'chat-command-head', command), el('pre', 'chat-command-output', output))
  return box
}

function noticeItem(tone: 'info' | 'error', text: string, action: ChatNoticeAction | null, line: string | null, cb: ItemCallbacks): HTMLElement {
  const row = el('div', `chat-notice ${tone}`)
  row.append(el('span', 'chat-notice-text', text))
  if (action === 'restart') row.append(button('Restart', () => cb.restart()))
  // a notice with a line types it in the terminal; one without only switches to the terminal. Both run as the composer runs a command.
  if (action === 'open-terminal') row.append(button('Open in the terminal', () => cb.openInTerminal(line ?? null)))
  if (action === 'open-mcp') row.append(button('MCP servers', () => cb.openMcp()))
  return row
}

/** the restart report's divider: its first `good` part is drawn in green, the rest as the text is */
function dividerItem(text: string, good: string | null): HTMLElement {
  const box = el('div', 'chat-divider')
  const line = el('span', 'chat-divider-text')
  const at = good ? text.indexOf(good) : -1
  if (good === null || at < 0) line.textContent = text
  else line.append(text.slice(0, at), el('span', 'chat-divider-good', good), text.slice(at + good.length))
  box.append(line)
  return box
}

/**
 * A change outside the chat that the session loads at its restart: a row with a ⚡ mark, its title and under it its text, and at
 * the right Not now (while the answer goes on) or Restart, by the action; no button when the chat cannot act on it.
 */
function reloadItem(item: Extract<ChatItem, { kind: 'reload' }>, cb: ItemCallbacks): HTMLElement {
  const row = el('div', 'chat-reload')
  const mark = el('span', 'chat-reload-mark', '⚡')
  const body = el('div', 'chat-reload-body')
  body.append(el('div', 'chat-reload-title', item.title), el('div', 'chat-reload-text', item.text))
  row.append(mark, body)
  if (item.action !== null && cb.reload !== null) {
    const reload = cb.reload
    if (item.action === 'restart') row.append(button('Restart', () => reload('restart')))
    else {
      const notNow = button('Not now', () => reload('not-now'))
      notNow.classList.add('ghost')
      row.append(notNow)
    }
  }
  return row
}
