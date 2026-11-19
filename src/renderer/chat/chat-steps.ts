import { type ChatCallState, type ChatItem, isAgentId, type ChatSubagent, type ChatToolCall } from '../../shared/chat'
import { runHead, type WorkflowAgentRow, type WorkflowPhase, type WorkflowRun } from '../../shared/workflow'
import type { ImageCard } from '../../shared/types'
import { icon } from '../icons'
import { imageUrl } from '../image-url'
import { rowAgent } from './agent-text'
import { formatTokens, modelFamily } from '../status-bar'
import type { ItemCallbacks } from './chat-items'

// The tool steps and the images of the chat. A step is a card while a call runs, and a pill once every call is done; its
// rows are updated in place, so a well the user unfolded stays unfolded. Everything here is text set with textContent,
// except our own icons.

export type StepCallbacks = Pick<ItemCallbacks, 'revealChange' | 'imageCard' | 'openImages' | 'openAgent'>
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

/** the colour of the agent at `index` of its card: the subagents' colours, cycling */
export function agentColor(index: number): string {
  return AGENT_COLORS[index % AGENT_COLORS.length]!
}

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

function childWith(parent: HTMLElement, key: 'call' | 'agent' | 'run' | 'phase', id: string): HTMLElement | null {
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
  // an Agent call's row opens its agent's page; a file's row reveals its change
  const press = (): void => {
    if (row.dataset.agent !== undefined) cb.openAgent(row.dataset.agent)
    else if (entry.dataset.edit !== undefined) cb.revealChange(entry.dataset.edit)
  }
  row.addEventListener('click', press)
  row.addEventListener('keydown', (e) => {
    // Space opens the row without scrolling the conversation
    if (e.key !== 'Enter' && e.key !== ' ') return
    if (row.dataset.agent === undefined && entry.dataset.edit === undefined) return
    e.preventDefault()
    press()
  })
  entry.append(row)
  return entry
}

function fillCall(entry: HTMLElement, call: ChatToolCall): void {
  const row = entry.querySelector<HTMLElement>(':scope > .chat-step-row')
  if (row === null) return
  // an Agent call with its agent known and its id valid: its row opens the agent's page
  const agentId = call.name === 'Task' || call.name === 'Agent' ? rowAgent(call) : null
  row.className = `chat-step-row${call.editPath !== null ? ' edit' : ''}${agentId !== null ? ' agent' : ''}${call.state === 'failed' ? ' failed' : ''}`
  if (call.editPath !== null) entry.dataset.edit = call.editPath
  else delete entry.dataset.edit
  if (agentId !== null) row.dataset.agent = agentId
  else delete row.dataset.agent
  if (call.editPath !== null || agentId !== null) {
    row.tabIndex = 0
    row.setAttribute('role', 'button')
  } else {
    row.removeAttribute('tabindex')
    row.removeAttribute('role')
  }
  if (agentId !== null) {
    row.title = 'Open this agent'
    if (row.querySelector(':scope > .chat-step-open') === null) row.append(el('span', 'chat-step-open', '›'))
  } else {
    row.removeAttribute('title')
    row.querySelector(':scope > .chat-step-open')?.remove()
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

/** a row of the card: a subagent, or a Workflow run drawn as a group (its head, its phase lines and its agents, indented) */
export type AgentCardRow = { kind: 'agent'; agent: ChatSubagent } | { kind: 'run'; run: WorkflowRun }

/** an agent as the card draws it: its colour's index (one counter over the heads and the agent rows), and for a run's agent its try and phase */
interface DrawnAgent { agent: ChatSubagent; color: number; attempt: number; phase: number | null }
/** a card's row as drawn: an agent, or a run with its agents in the order its body draws them */
type Drawn = { kind: 'agent'; item: DrawnAgent } | { kind: 'run'; run: WorkflowRun; color: number; agents: DrawnAgent[] }

/** the card's rows in drawing order: a run's head takes a colour, then its agents take the next ones */
function drawCard(rows: AgentCardRow[]): Drawn[] {
  let color = 0
  return rows.map((row): Drawn => {
    if (row.kind === 'agent') return { kind: 'agent', item: { agent: row.agent, color: color++, attempt: 1, phase: null } }
    const head = color++
    const phases = row.run.phases.map((phase) => phase.index)
    const agents = runAgentOrder(row.run).map((agent): DrawnAgent => ({
      agent: runAgent(row.run, agent), color: color++, attempt: agent.attempt, phase: phases.includes(agent.phase ?? -1) ? agent.phase : null
    }))
    return { kind: 'run', run: row.run, color: head, agents }
  })
}

const agentsOf = (drawn: Drawn[]): DrawnAgent[] => drawn.flatMap((item) => (item.kind === 'agent' ? [item.item] : item.agents))

/** every agent of the card in drawing order, a run's agents among them as agents */
export function cardAgents(rows: AgentCardRow[]): ChatSubagent[] {
  return agentsOf(drawCard(rows)).map((item) => item.agent)
}

/** whether the card has something running: an agent, or a Workflow run */
export function cardRunning(rows: AgentCardRow[]): boolean {
  return rows.some((row) => (row.kind === 'agent' ? row.agent.state === 'running' : row.run.state === 'running'))
}

/** the colour index of an agent of the card, the same index its row takes; -1 when the card has no such agent */
export function cardColor(rows: AgentCardRow[], agentId: string): number {
  return agentsOf(drawCard(rows)).find((item) => item.agent.id === agentId)?.color ?? -1
}

/** the card's state for one drawing: the open choice and whether rows are buttons */
interface CardDraw { button: boolean; current: string | null; open(row: HTMLElement): void }

/**
 * The subagents' card, drawn into `box` (the chat's dock): a head with its count, then the rows in the order given. A row is kept by
 * its agent's id (a run by its key), so its ring and bar carry on when the card is drawn again. A row is a button that opens the
 * agent's page through `o.open`; the row of `o.current` is marked as the open one.
 */
export function fillAgentsCard(box: HTMLElement, rows: AgentCardRow[], o: { open?(agentId: string): void; current?: string | null } = {}): void {
  let card = box.querySelector<HTMLElement>(':scope > .chat-agents')
  if (card === null) {
    card = el('div', 'chat-agents')
    card.append(el('div', 'chat-agents-head'), followingList())
    box.append(card)
  }
  const drawn = drawCard(rows)
  const agents = agentsOf(drawn).map((item) => item.agent)
  const n = agents.length
  const done = agents.filter((agent) => agent.state === 'done').length
  card.querySelector<HTMLElement>('.chat-agents-head')!.innerHTML = `${icon('users', 13)}<span>${n} agent${n === 1 ? '' : 's'} · ${done} done</span>`
  const list = card.querySelector<HTMLElement>('.chat-agents-list')!
  const draw: CardDraw = {
    button: o.open !== undefined,
    current: o.current ?? null,
    open: (row) => {
      if (isAgentId(row.dataset.agent)) o.open?.(row.dataset.agent)
    }
  }
  const top = drawn.map((item) => (item.kind === 'agent' ? agentRow(list, item.item, false, draw) : runGroup(list, item, draw)))
  keepOnly(list, top)
  arrange(list, top)
  followEnd(list)
}

/** a subagent's row, kept by its id in `parent`; a run's agent (`inRun`) is drawn in its run's body */
function agentRow(parent: HTMLElement, item: DrawnAgent, inRun: boolean, draw: CardDraw): HTMLElement {
  const { agent } = item
  const row = childWith(parent, 'agent', agent.id) ?? makeAgentRow(agent.id, inRun, draw)
  // a row is a button only when it has an agent's id to open
  if (draw.button && isAgentId(agent.id)) {
    row.tabIndex = 0
    row.setAttribute('role', 'button')
    row.title = 'Open this agent'
  } else {
    row.removeAttribute('tabindex')
    row.removeAttribute('role')
    row.removeAttribute('title')
  }
  if (draw.current === agent.id) row.setAttribute('aria-current', 'true')
  else row.removeAttribute('aria-current')
  // a row keeps its colour and its bar's offset by its place in the card, which does not change when another row ends. The
  // offset is a negative delay: the bar starts that far into its slide, so the bars are staggered and none stands still when
  // its slide starts again (a chat that comes back from another tab starts its animations anew)
  row.style.setProperty('--agent', agentColor(item.color))
  row.style.setProperty('--bar-delay', `-${(item.color * 0.5).toFixed(1)}s`)
  fillAgent(row, agent, item.attempt)
  return row
}

function makeAgentRow(id: string, inRun: boolean, draw: CardDraw): HTMLElement {
  const row = el('div', 'chat-agent')
  row.dataset.agent = id
  if (inRun) row.classList.add('chat-run-agent')
  row.addEventListener('click', () => draw.open(row))
  row.addEventListener('keydown', (e) => {
    // Space opens the row without scrolling the conversation
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    draw.open(row)
  })
  row.append(el('span', 'chat-step-state'), el('span', 'chat-agent-type'), el('span', 'chat-agent-desc'), el('span', 'chat-agent-meta'), el('span', 'chat-agent-state'))
  return row
}

/**
 * A Workflow run's group in `parent`: its head row, then its body with the phase lines and the agents' rows. The head folds the
 * group on a click or Enter/Space. Until the person toggles it, a run is folded exactly when it is not running.
 */
function runGroup(parent: HTMLElement, item: Extract<Drawn, { kind: 'run' }>, draw: CardDraw): HTMLElement {
  const { run } = item
  const group = childWith(parent, 'run', run.key) ?? makeRunGroup(run.key)
  const head = group.querySelector<HTMLElement>(':scope > .chat-run-head')!
  fillAgent(head, runHeadAgent(run), 1)
  setText(head.querySelector<HTMLElement>('.chat-agent-meta')!, 'workflow')
  if (run.state === 'stopped') head.querySelector<HTMLElement>('.chat-agent-state')!.textContent = 'stopped'
  head.style.setProperty('--agent', agentColor(item.color))
  head.style.setProperty('--bar-delay', `-${(item.color * 0.5).toFixed(1)}s`)
  const folding = group.dataset.fold
  foldRun(group, folding === 'closed' || (folding === undefined && run.state !== 'running'))
  const body = group.querySelector<HTMLElement>(':scope > .chat-run-body')!
  const nodes: HTMLElement[] = []
  for (const phase of run.phases) {
    nodes.push(phaseLine(body, phase))
    for (const agent of item.agents) if (agent.phase === phase.index) nodes.push(agentRow(body, agent, true, draw))
  }
  for (const agent of item.agents) if (agent.phase === null) nodes.push(agentRow(body, agent, true, draw))
  keepOnly(body, nodes)
  arrange(body, nodes)
  return group
}

function makeRunGroup(key: string): HTMLElement {
  const group = el('div', 'chat-run')
  group.dataset.run = key
  const head = el('div', 'chat-agent chat-run-head')
  head.tabIndex = 0
  head.setAttribute('role', 'button')
  head.append(el('span', 'chat-step-state'), el('span', 'chat-agent-type'), el('span', 'chat-agent-desc'), el('span', 'chat-agent-meta'), el('span', 'chat-agent-state'))
  head.addEventListener('click', () => toggleRun(group))
  head.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    toggleRun(group)
  })
  group.append(head, el('div', 'chat-run-body'))
  return group
}

/** the person's fold choice is kept on the group while it lives: `closed` or `open` */
function toggleRun(group: HTMLElement): void {
  const folded = group.dataset.folded === undefined
  foldRun(group, folded)
  group.dataset.fold = folded ? 'closed' : 'open'
  const list = group.closest<HTMLElement>('.chat-agents-list')
  if (list !== null) followEnd(list)
}

/** a run's group folded or unfolded: its body hidden, its chevron and its head's expanded state set */
function foldRun(group: HTMLElement, folded: boolean): void {
  if (folded) group.dataset.folded = ''
  else delete group.dataset.folded
  group.querySelector<HTMLElement>(':scope > .chat-run-body')!.hidden = folded
  const head = group.querySelector<HTMLElement>(':scope > .chat-run-head')!
  head.setAttribute('aria-expanded', String(!folded))
  const type = head.querySelector<HTMLElement>('.chat-agent-type')!
  let chevron = type.querySelector<HTMLElement>(':scope > .chat-run-chevron')
  if (chevron === null) {
    chevron = el('span', 'chat-run-chevron')
    type.prepend(chevron)
  }
  chevron.textContent = folded ? '▸' : '▾'
}

/** a run's phase line in its body, kept by the phase's index */
function phaseLine(body: HTMLElement, phase: WorkflowPhase): HTMLElement {
  let line = childWith(body, 'phase', String(phase.index))
  if (line === null) {
    line = el('div', 'chat-run-phase')
    line.dataset.phase = String(phase.index)
  }
  setText(line, phase.title)
  return line
}

/** the run as the head row draws it: its name, `<phase> · N of M done`, and its state (a stopped run reads failed here, then stopped) */
function runHeadAgent(run: WorkflowRun): ChatSubagent {
  const head = runHead(run)
  const count = `${head.done} of ${head.total} done`
  const agent: ChatSubagent = {
    id: run.key, type: run.name, description: head.phase === null ? count : `${head.phase} · ${count}`,
    state: run.state === 'running' ? 'running' : run.state === 'done' ? 'done' : 'failed', ms: run.ms
  }
  if (run.startedAt !== null) agent.startedAt = run.startedAt
  return agent
}

/** a run's agent as a card row: its label, its task, its state and the call's model and effort, as far as they are known */
function runAgent(run: WorkflowRun, row: WorkflowAgentRow): ChatSubagent {
  const agent: ChatSubagent = { id: row.agentId ?? `${run.key}:${row.key}`, type: row.label, description: row.task ?? '', state: row.state, ms: row.ms }
  if (row.model !== null) agent.model = row.model
  if (row.effort !== null) agent.effort = row.effort
  if (row.startedAt !== null) agent.startedAt = row.startedAt
  return agent
}

/** a run's agents in the order its body draws them: by phase in the phases' order, the agents of no phase last; each keeps its start order */
function runAgentOrder(run: WorkflowRun): WorkflowAgentRow[] {
  const rank = (phase: number | null): number => {
    const at = run.phases.findIndex((p) => p.index === phase)
    return at === -1 ? run.phases.length : at
  }
  return [...run.agents].sort((a, b) => rank(a.phase) - rank(b.phase))
}

/** the children of `parent` that are not in `nodes` go: a row that left the card */
function keepOnly(parent: HTMLElement, nodes: HTMLElement[]): void {
  const keep = new Set<Element>(nodes)
  for (const child of Array.from(parent.children)) if (!keep.has(child)) child.remove()
}

/** the nodes in `parent` in the order given: a node is moved only when it is not in its place yet */
function arrange(parent: HTMLElement, nodes: HTMLElement[]): void {
  nodes.forEach((node, i) => {
    if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] ?? null)
  })
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
  // a size changed inside a ResizeObserver callback raises "ResizeObserver loop completed with undelivered notifications": fitRows waits a frame
  new ResizeObserver(() => requestAnimationFrame(() => followEnd(list))).observe(list)
  return list
}

/**
 * The list shows whole rows: when its rows are taller than its max-height, its height is the rows from the first one that fits to the
 * end, so a list at its end never cuts its top row; a list whose rows fit takes their height. A list with no max-height is left alone
 */
function fitRows(list: HTMLElement): void {
  const cap = parseFloat(getComputedStyle(list).maxHeight)
  if (!Number.isFinite(cap) || (list.clientHeight === 0 && list.style.height === '')) return
  const total = list.scrollHeight
  if (total <= cap + 0.5) {
    if (list.style.height !== '') list.style.height = ''
    return
  }
  const base = list.getBoundingClientRect().top - list.scrollTop
  for (const row of list.querySelectorAll<HTMLElement>('.chat-agent, .chat-run-phase')) {
    if (row.getClientRects().length === 0) continue // a row of a folded run
    const top = row.getBoundingClientRect().top - base
    if (total - top <= cap + 0.5) {
      const height = `${total - top}px`
      if (list.style.height !== height) list.style.height = height
      return
    }
  }
}

function followEnd(list: HTMLElement): void {
  fitRows(list)
  if (list.dataset.follow !== 'off') list.scrollTop = list.scrollHeight
}

function fillAgent(row: HTMLElement, agent: ChatSubagent, attempt: number): void {
  setStateIcon(row.querySelector<HTMLElement>('.chat-step-state')!, agent.state)
  setText(row.querySelector<HTMLElement>('.chat-agent-type')!, agent.type)
  const desc = row.querySelector<HTMLElement>('.chat-agent-desc')!
  // a retried agent says so before its task: the amber chip of its try
  if (attempt > 1) desc.replaceChildren(el('span', 'chat-agent-attempt', `attempt ${attempt}`), ` ${agent.description}`)
  else setText(desc, agent.description)
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
