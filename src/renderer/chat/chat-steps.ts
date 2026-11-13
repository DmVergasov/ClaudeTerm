import type { ChatCallState, ChatItem, ChatSubagent, ChatToolCall } from '../../shared/chat'
import type { ImageCard } from '../../shared/types'
import { icon } from '../icons'
import { imageUrl } from '../image-url'
import { formatTokens, modelFamily } from '../status-bar'
import type { ItemCallbacks } from './chat-items'

// The tool steps and the images of the chat. A step is a card while a call runs, and a pill once every call is done; its
// rows are updated in place, so a well the user unfolded stays unfolded. Everything here is text set with textContent,
// except our own icons.

export type StepCallbacks = Pick<ItemCallbacks, 'revealChange' | 'imageCard' | 'openImages'>
type Step = Extract<ChatItem, { kind: 'tools' }>

/** the lines a folded Bash well shows: the last of its output */
const WELL_LINES = 5
const LINE_BREAK = 10
/** the whole output of each Bash well, by the well: the folded one shows its last lines */
const wellOutput = new WeakMap<HTMLElement, string>()
/** a call that runs this long opens its step by itself: a short call never flashes it open */
const LONG_CALL_MS = 2000
/** the timer that opens a step whose call has run long, per step */
const longTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()
/** the subagents' colours, by a row's place in its card, cycling */
const AGENT_COLORS = ['#7FA7F5', '#A78BFA', '#5BC0D8', '#E0A458', '#F28FAD', '#6CC5A8']

/** a row's text is written only when it differs: an unchanged text node keeps the selection and the Find ranges in it */
const setText = (node: HTMLElement, text: string): void => {
  if (node.textContent !== text) node.textContent = text
}

const el = (tag: string, className: string, text = ''): HTMLElement => {
  const e = document.createElement(tag)
  e.className = className
  e.textContent = text
  return e
}

/**
 * The step's open choice: true or false when the user chose it. A well the user unfolded counts as a choice to open the
 * step; otherwise null, and the step follows its calls.
 */
function stepsOpen(root: HTMLElement): boolean | null {
  const choice = root.dataset.open
  if (choice !== undefined) return choice === '1'
  return root.querySelector('.chat-well.unfolded') !== null ? true : null
}

/** the user's choices in a tool step: whether it is open (null when it follows its calls), and the calls whose well is unfolded */
export interface StepKeep {
  open: boolean | null
  wells: string[]
}

/** the choices of a step as its node shows them now: kept when the node leaves the DOM, so the step is drawn again with them */
export function stepKeep(root: HTMLElement): StepKeep {
  const wells: string[] = []
  root.querySelectorAll<HTMLElement>('.chat-well.unfolded').forEach((well) => {
    const call = well.parentElement?.dataset.call
    if (call !== undefined) wells.push(call)
  })
  return { open: stepsOpen(root), wells }
}

/** a tool step, drawn from its calls; `keep` is the user's choices for it, null when it follows its calls; `settled` is set by the view */
export function renderSteps(item: Step, cb: StepCallbacks, keep: StepKeep | null, settled = true): HTMLElement {
  const root = el('div', 'chat-steps')
  root.dataset.settled = settled ? '1' : '0'
  const open = keep?.open ?? null
  if (open !== null) root.dataset.open = open ? '1' : '0'
  const head = el('button', 'chat-step-head') as HTMLButtonElement
  head.type = 'button'
  const chevron = el('span', 'chat-step-chevron')
  chevron.innerHTML = icon('chevron-down', 12)
  head.append(chevron, el('span', 'chat-step-label'))
  head.addEventListener('click', () => {
    root.dataset.open = root.classList.contains('open') ? '0' : '1'
    fold(root)
  })
  root.append(head, el('div', 'chat-step-list'))
  updateSteps(root, item, cb)
  unfoldWells(root, keep?.wells ?? [])
  return root
}

/** the Bash wells the user unfolded are unfolded again, and the step with them */
function unfoldWells(root: HTMLElement, calls: string[]): void {
  const list = root.querySelector<HTMLElement>(':scope > .chat-step-list')
  if (list === null || calls.length === 0) return
  for (const id of calls) {
    const well = childWith(list, 'call', id)?.querySelector<HTMLElement>(':scope > .chat-well')
    if (!well) continue
    well.classList.add('unfolded')
    paintWell(well)
  }
  fold(root)
}

/**
 * The step drawn again from its items: each call's row is updated where it is, a new call is added at the end. `changed` is
 * the one call a patch changed: only its row is filled, so the other rows keep what the user selected in them.
 */
export function updateSteps(root: HTMLElement, item: Step, cb: StepCallbacks, changed: string | null = null): void {
  const list = root.querySelector<HTMLElement>(':scope > .chat-step-list')
  if (list === null) return
  const running = item.calls.some((call) => call.state === 'running')
  root.dataset.running = running ? '1' : '0'
  const label = root.querySelector<HTMLElement>('.chat-step-label')
  if (label !== null) label.textContent = headText(item, running)
  for (const call of item.calls) {
    let entry = childWith(list, 'call', call.id)
    const created = entry === null
    if (entry === null) {
      entry = callEntry(call.id, cb)
      list.append(entry)
    }
    if (created || changed === null || call.id === changed) fillCall(entry, call)
  }
  // a call the step no longer has (a step that shrank) goes with its row
  const ids = new Set(item.calls.map((call) => call.id))
  for (const child of Array.from(list.children)) {
    if (child instanceof HTMLElement && !ids.has(child.dataset.call ?? '')) child.remove()
  }
  // the subagents of the Agent calls are not drawn in the step: the chat's dock above the composer draws them
  fold(root)
}

/**
 * Find's match is in a folded step: the step opens as the user would open it, and each Bash well whose whole output holds the
 * term shows whole. `holds` tells whether a text holds the term.
 */
export function openForMatch(root: HTMLElement, holds: (text: string) => boolean): () => void {
  const before = root.dataset.open
  const unfolded: HTMLElement[] = []
  root.dataset.open = '1'
  root.querySelectorAll<HTMLElement>(':scope > .chat-step-list > .chat-step-call > .chat-well').forEach((well) => {
    if (!holds(wellOutput.get(well) ?? '')) return
    if (!well.classList.contains('unfolded')) {
      well.classList.add('unfolded')
      unfolded.push(well)
    }
    paintWell(well)
  })
  fold(root)
  // the undo puts back the step's choice and the wells it unfolded, for a match the step does not show after all
  return () => {
    if (before === undefined) delete root.dataset.open
    else root.dataset.open = before
    for (const well of unfolded) {
      well.classList.remove('unfolded')
      paintWell(well)
    }
    fold(root)
  }
}

/** the images of an images item that have a Media card; an image without one is not drawn */
export function renderImages(item: Extract<ChatItem, { kind: 'images' }>, cb: StepCallbacks): HTMLElement {
  const box = el('div', 'chat-images')
  const cards: ImageCard[] = []
  for (const image of item.images) {
    const card = image.cardId === null ? null : cb.imageCard(image.cardId)
    if (card !== null) cards.push(card)
  }
  cards.forEach((card, index) => {
    const button = el('button', 'chat-image-card') as HTMLButtonElement
    button.type = 'button'
    const thumb = el('div', 'chat-image-thumb')
    const img = document.createElement('img')
    img.src = imageUrl(card)
    img.alt = card.name
    thumb.append(img)
    button.append(thumb, el('div', 'chat-image-name', card.name))
    button.addEventListener('click', () => cb.openImages(cards, index))
    box.append(button)
  })
  return box
}

/** the step's header: `Running 3 tools` while a call runs, then the pill's `Ran 3 tools · 6.1s` */
function headText(item: Step, running: boolean): string {
  const n = item.calls.length
  const tools = `${n} tool${n === 1 ? '' : 's'}`
  if (running) return `Running ${tools}`
  return item.ms === null ? `Ran ${tools}` : `Ran ${tools} · ${(item.ms / 1000).toFixed(1)}s`
}

/**
 * whether the step is settled: an item follows it, or its turn is over. Until then its card stays open, also between its
 * calls, so it does not flicker to a pill and back while Claude works
 */
export function setSettled(root: HTMLElement, settled: boolean): void {
  root.dataset.settled = settled ? '1' : '0'
  // a settled step folds again: the long call that opened it is over
  if (settled) delete root.dataset.long
  fold(root)
}

/**
 * The step is open while one of its calls has run for over 2 s (until the turn settles), or while a well is unfolded, unless the
 * user chose otherwise; else it is the pill. A step with a running call arms the timer that opens it.
 */
function fold(root: HTMLElement): void {
  // a settled step does not open by itself again: its turn has moved on, even if a call of it still runs
  if (root.dataset.running === '1' && root.dataset.settled !== '1') armLong(root)
  else disarmLong(root)
  const choice = stepsOpen(root)
  const open = choice ?? (root.dataset.long === '1' || root.querySelector('.chat-well.unfolded') !== null)
  root.classList.toggle('open', open)
  root.classList.toggle('folded', !open)
  root.querySelector('.chat-step-head')?.setAttribute('aria-expanded', String(open))
}

/** starts the timer that opens the step once its call has run long */
function armLong(root: HTMLElement): void {
  if (root.dataset.long === '1' || longTimers.has(root)) return
  longTimers.set(root, setTimeout(() => openLong(root), LONG_CALL_MS))
}

/** the timer's end: a step still running opens, unless its view is hidden, where it waits for the view to show */
function openLong(root: HTMLElement): void {
  longTimers.delete(root)
  if (!root.isConnected || root.dataset.running !== '1') return
  if (root.getClientRects().length === 0) {
    longTimers.set(root, setTimeout(() => openLong(root), LONG_CALL_MS))
    return
  }
  root.dataset.long = '1'
  fold(root)
}

function disarmLong(root: HTMLElement): void {
  const timer = longTimers.get(root)
  if (timer !== undefined) clearTimeout(timer)
  longTimers.delete(root)
}

function childWith(parent: HTMLElement, key: 'call' | 'agent', id: string): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (child instanceof HTMLElement && child.dataset[key] === id) return child
  }
  return null
}

/** one call: its row, then the Bash well and the error under it */
function callEntry(id: string, cb: StepCallbacks): HTMLElement {
  const entry = el('div', 'chat-step-call')
  entry.dataset.call = id
  const row = el('div', 'chat-step-row')
  row.append(el('span', 'chat-step-state'), el('span', 'chat-tool-name'), el('span', 'chat-tool-subject'), el('span', 'chat-tool-detail'))
  row.addEventListener('click', () => {
    if (entry.dataset.edit !== undefined) cb.revealChange(entry.dataset.edit)
  })
  row.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && entry.dataset.edit !== undefined) {
      e.preventDefault()
      cb.revealChange(entry.dataset.edit)
    }
  })
  entry.append(row)
  return entry
}

function fillCall(entry: HTMLElement, call: ChatToolCall): void {
  const row = entry.querySelector<HTMLElement>(':scope > .chat-step-row')
  if (row === null) return
  row.className = `chat-step-row${call.editPath !== null ? ' edit' : ''}${call.state === 'failed' ? ' failed' : ''}`
  if (call.editPath !== null) {
    entry.dataset.edit = call.editPath
    row.tabIndex = 0
    row.setAttribute('role', 'button')
  } else {
    delete entry.dataset.edit
    row.removeAttribute('tabindex')
    row.removeAttribute('role')
  }
  setStateIcon(row.querySelector<HTMLElement>('.chat-step-state')!, call.state)
  setText(row.querySelector<HTMLElement>('.chat-tool-name')!, call.name)
  setText(row.querySelector<HTMLElement>('.chat-tool-subject')!, call.subject)
  detailText(row.querySelector<HTMLElement>('.chat-tool-detail')!, call.detail)
  fillWell(entry, row, call)
  fillError(entry, call.error)
}

/** a state's icon: the ring while it runs, a check when done, a cross when failed; drawn once per state, so the ring keeps turning */
function setStateIcon(node: HTMLElement, state: ChatCallState): void {
  if (node.dataset.state === state) return
  node.dataset.state = state
  node.className = `chat-step-state ${state}`
  node.textContent = ''
  if (state === 'running') node.append(el('span', 'chat-ring'))
  else node.innerHTML = icon(state === 'done' ? 'check' : 'x', 13)
}

/** the `+n` green and `−n` red of a detail; any other detail is plain */
function detailText(node: HTMLElement, detail: string | null): void {
  // the detail is drawn again only when it changed: its text nodes stay as they are
  const key = detail ?? ''
  if (node.dataset.detail === key) return
  node.dataset.detail = key
  node.textContent = ''
  if (detail === null) return
  const m = /^(\+\d+)?(?:\s*(−\d+))?$/.exec(detail)
  if (m === null || (m[1] === undefined && m[2] === undefined)) {
    node.textContent = detail
    return
  }
  if (m[1] !== undefined) node.append(el('span', 'plus', m[1]))
  if (m[2] !== undefined) {
    if (m[1] !== undefined) node.append(' ')
    node.append(el('span', 'minus', m[2]))
  }
}

/** a Bash call's output in a well: the last lines, and the whole output once the user unfolds it */
function fillWell(entry: HTMLElement, row: HTMLElement, call: ChatToolCall): void {
  let well = entry.querySelector<HTMLElement>(':scope > .chat-well')
  if (call.name !== 'Bash') {
    well?.remove()
    return
  }
  if (well === null) {
    const node = el('div', 'chat-well')
    node.append(el('pre', 'chat-well-text'))
    node.addEventListener('click', () => {
      node.classList.toggle('unfolded')
      paintWell(node)
      // a well the user unfolds keeps its step open, so the output is not folded away under the user
      const step = node.closest<HTMLElement>('.chat-steps')
      if (step !== null) fold(step)
    })
    row.after(node)
    well = node
  }
  // the output is split and drawn only when it changed: a call patch does not cost the output again
  const output = call.output ?? ''
  if (wellOutput.get(well) !== output) {
    wellOutput.set(well, output)
    paintWell(well)
  }
  // a well with no output yet takes no height: it shows when the output comes
  well.hidden = output === ''
}

function paintWell(well: HTMLElement): void {
  const pre = well.querySelector<HTMLElement>('.chat-well-text')
  if (pre === null) return
  const output = wellOutput.get(well) ?? ''
  pre.textContent = well.classList.contains('unfolded') ? output : lastLines(output, WELL_LINES)
}

/**
 * The last `n` lines of a text, without the line breaks after its last character. One backward scan from the end, so a
 * long run of line breaks costs no more than its length.
 */
function lastLines(text: string, n: number): string {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === LINE_BREAK) end--
  let start = 0
  let breaks = 0
  for (let i = end - 1; i >= 0; i--) {
    if (text.charCodeAt(i) !== LINE_BREAK) continue
    breaks++
    if (breaks === n) {
      start = i + 1
      break
    }
  }
  return text.slice(start, end)
}

function fillError(entry: HTMLElement, error: string | null): void {
  let node = entry.querySelector<HTMLElement>(':scope > .chat-step-error')
  if (error === null) {
    node?.remove()
    return
  }
  if (node === null) {
    node = el('div', 'chat-step-error')
    entry.append(node)
  }
  setText(node, error)
}

/**
 * The subagents' card, drawn into `box` (the chat's dock): a head with its count, one row per agent, in the order given. A row is
 * kept by its agent's id, so its ring and bar carry on when the card is drawn again.
 */
export function fillAgentsCard(box: HTMLElement, agents: ChatSubagent[]): void {
  let card = box.querySelector<HTMLElement>(':scope > .chat-agents')
  if (card === null) {
    card = el('div', 'chat-agents')
    card.append(el('div', 'chat-agents-head'), followingList())
    box.append(card)
  }
  const n = agents.length
  const done = agents.filter((agent) => agent.state === 'done').length
  card.querySelector<HTMLElement>('.chat-agents-head')!.innerHTML = `${icon('users', 13)}<span>${n} agent${n === 1 ? '' : 's'} · ${done} done</span>`
  const list = card.querySelector<HTMLElement>('.chat-agents-list')!
  let added = false
  agents.forEach((agent, index) => {
    let row = childWith(list, 'agent', agent.id)
    if (row === null) {
      row = el('div', 'chat-agent')
      row.dataset.agent = agent.id
      row.append(el('span', 'chat-step-state'), el('span', 'chat-agent-type'), el('span', 'chat-agent-desc'), el('span', 'chat-agent-meta'), el('span', 'chat-agent-state'))
      list.append(row)
      added = true
    }
    // a row keeps its colour and its bar's offset by its place in the card, which does not change when another row ends. The
    // offset is a negative delay: the bar starts that far into its slide, so the bars are staggered and none stands still when
    // its slide starts again (a chat that comes back from another tab starts its animations anew)
    row.style.setProperty('--agent', AGENT_COLORS[index % AGENT_COLORS.length]!)
    row.style.setProperty('--bar-delay', `-${(index * 0.5).toFixed(1)}s`)
    fillAgent(row, agent)
  })
  const ids = new Set(agents.map((agent) => agent.id))
  for (const child of Array.from(list.children)) {
    if (child instanceof HTMLElement && !ids.has(child.dataset.agent ?? '')) child.remove()
  }
  if (added) followEnd(list)
}

/**
 * The agents' list, which scrolls once it has more rows than it shows. It follows its end, as the conversation does: a new
 * row, the list growing or coming back into view shows its last rows, unless the reader scrolled up in it; scrolling back
 * down to the end makes it follow again.
 */
function followingList(): HTMLElement {
  const list = el('div', 'chat-agents-list')
  list.addEventListener('scroll', () => {
    // a list that shows nothing (its chat hidden) says nothing of where the reader is
    if (list.clientHeight === 0) return
    list.dataset.follow = list.scrollHeight - list.scrollTop - list.clientHeight <= 2 ? '' : 'off'
  })
  new ResizeObserver(() => followEnd(list)).observe(list)
  return list
}

function followEnd(list: HTMLElement): void {
  if (list.dataset.follow !== 'off') list.scrollTop = list.scrollHeight
}

function fillAgent(row: HTMLElement, agent: ChatSubagent): void {
  setStateIcon(row.querySelector<HTMLElement>('.chat-step-state')!, agent.state)
  setText(row.querySelector<HTMLElement>('.chat-agent-type')!, agent.type)
  setText(row.querySelector<HTMLElement>('.chat-agent-desc')!, agent.description)
  fillAgentMeta(row.querySelector<HTMLElement>('.chat-agent-meta')!, agent)
  const text = row.querySelector<HTMLElement>('.chat-agent-state')!
  if (agent.state === 'running') {
    // a running row's last column is how long it has run, then its bar: a track the bar slides through, in the row's colour
    if (text.querySelector('.chat-agent-bar') === null) {
      const track = el('span', 'chat-agent-track')
      track.append(el('span', 'chat-agent-bar'))
      text.replaceChildren(el('span', 'chat-agent-time'), track)
    }
    if (agent.startedAt === undefined) delete row.dataset.started
    else row.dataset.started = String(agent.startedAt)
    tickAgentTime(row, Date.now())
    return
  }
  delete row.dataset.started
  text.replaceChildren()
  if (agent.state === 'failed') text.textContent = 'failed'
  else text.textContent = agent.ms === null ? 'done' : `done · ${durationText(agent.ms)}`
}

/** a running row's time since its agent started; none when the start is not known */
function tickAgentTime(row: HTMLElement, now: number): void {
  const time = row.querySelector<HTMLElement>('.chat-agent-time')
  if (time === null) return
  const started = Number(row.dataset.started)
  time.hidden = row.dataset.started === undefined || !Number.isFinite(started)
  if (!time.hidden) setText(time, elapsedText(now - started))
}

/** the running rows of the dock count on: called once a second while an agent runs */
export function tickAgentTimes(box: HTMLElement, now = Date.now()): void {
  for (const row of Array.from(box.querySelectorAll<HTMLElement>('.chat-agent[data-started]'))) tickAgentTime(row, now)
}

/**
 * What an agent runs with, as far as it is known: its model's family, the effort its call asks for, the tokens of its context
 * (`haiku · high · ctx 32k`); the full model name and the exact count are its tooltip. An agent with none of them shows nothing.
 */
function fillAgentMeta(node: HTMLElement, agent: ChatSubagent): void {
  const short = [agent.model === undefined ? null : modelFamily(agent.model), agent.effort ?? null, agent.context === undefined ? null : `ctx ${formatTokens(agent.context)}`]
  const long = [agent.model ?? null, agent.effort === undefined ? null : `effort ${agent.effort}`, agent.context === undefined ? null : `${agent.context.toLocaleString('en-US')} tokens in context`]
  setText(node, short.filter((part) => part !== null).join(' · '))
  const title = long.filter((part) => part !== null).join(' · ')
  if (title === '') node.removeAttribute('title')
  else node.title = title
}

/** a duration in whole seconds, at least one: `14s`, then `2m 30s` as a running agent counts */
export function durationText(ms: number): string {
  return elapsedText(Math.max(1, Math.round(ms / 1000)) * 1000)
}

/** the elapsed time of a turn as the working line shows it: `12s`, then `1m 05s` */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
