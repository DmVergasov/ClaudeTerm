import { acceptPatches, type AgentPatch, type AgentSnapshot, type ChatAgentInfo, type ChatItem } from '../../shared/chat'
import { icon } from '../icons'
import { AgentColumn } from './agent-column'
import type { ItemCallbacks } from './chat-items'
import { agentStateText, NOT_REACHED, OFF_EXITED, OFF_MEMBER, STOPPED_HINT, WRITE_HINT } from './agent-text'
import type { FindView } from './chat-find'

// The agent page: an agent's conversation in the chat view, in place of the main conversation and its composer. The header says
// what the agent is and what state it is in; the column holds its items (agent-column.ts).

export interface AgentPageOptions {
  agentId: string
  cb: ItemCallbacks
  /** the agent's colour: its ring in the header */
  color: string
  back(): void
  /** the waiting bar's click: back to the conversation, and to the card that waits there */
  backToCard(): void
  /** the page of items before `beforeId`; null when the agent is gone */
  older(beforeId: string): Promise<{ items: ChatItem[]; hasOlder: boolean } | null>
  /** the message box's send: the refusal, or null when the message went (through the main conversation, as a forward) */
  send(text: string): Promise<string | null>
  /** the draft the box starts with, and what each change of it leaves: the chat keeps one draft per agent */
  draft: string
  keepDraft(text: string): void
  /** a message went: the chat drops the draft it was sent from, unless that draft has changed since (then it stays) */
  sent(draft: string): void
  /** a member's device: the host's agent is read here, not written */
  readOnly: boolean
}

const el = (tag: string, className: string, text = ''): HTMLElement => {
  const e = document.createElement(tag)
  e.className = className
  e.textContent = text
  return e
}

/** a text is written only when it differs, so an unchanged text node keeps the selection in it */
const setText = (node: HTMLElement, text: string): void => {
  if (node.textContent !== text) node.textContent = text
}

export class AgentPage {
  readonly agentId: string
  /** the page: its header and its column, in place of the conversation's body */
  readonly element = el('div', 'agent-page')
  /** the footer, in place of the composer: the message box to the agent, or the one line that says why writing is off */
  readonly footer = el('div', 'agent-footer')
  /** the message box's part of the footer: its refusal, the field and its hint; hidden while writing is off */
  private readonly compose = el('div', 'agent-compose')
  private readonly refusal = el('div', 'agent-refusal')
  private readonly input = document.createElement('textarea')
  private readonly hint = el('div', 'agent-hint', WRITE_HINT)
  /** the line in place of the message box while writing is off */
  private readonly off = el('div', 'agent-off')
  private readonly readOnly: boolean
  /** whether the chat takes a message: the snapshot says so, and the chat's exit says the rest */
  private writable = true
  private exited = false
  /** a message is on its way to the agent: a second Enter waits for the answer */
  private sending = false
  /** the page is closed: a send that answers after that touches none of its DOM */
  private disposed = false
  private readonly back = el('button', 'agent-back') as HTMLButtonElement
  private readonly type = el('span', 'agent-type')
  private readonly desc = el('span', 'agent-desc')
  private readonly state = el('span', 'agent-state')
  private readonly mark = el('span', 'agent-mark')
  private readonly stateText = el('span', 'agent-state-text')
  /** the bar under the header while the main conversation has a card that waits for an answer: a click goes back to it */
  private readonly wait = el('button', 'agent-wait') as HTMLButtonElement
  private readonly column: AgentColumn
  private agent: ChatAgentInfo | null = null
  private rev = -1
  private visible = false
  /** the state's text ticks once a second while the page shows and the agent runs */
  private clock: ReturnType<typeof setInterval> | null = null
  /** the state the header's mark was drawn for: the ring is drawn once per state, so it keeps turning */
  private markState: string | null = null

  constructor(o: AgentPageOptions) {
    this.agentId = o.agentId
    this.element.tabIndex = -1
    this.element.style.setProperty('--agent', o.color)
    this.footer.className = 'agent-footer'
    this.readOnly = o.readOnly
    this.input.className = 'agent-input'
    this.input.rows = 1
    this.input.value = o.draft
    this.refusal.hidden = true
    this.refusal.setAttribute('role', 'alert')
    this.input.addEventListener('input', () => o.keepDraft(this.input.value))
    this.input.addEventListener('keydown', (e) => {
      // Enter sends and Shift+Enter starts a line; Esc is the chat's, which returns to the conversation and keeps the draft
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
      e.preventDefault()
      void this.submit(o)
    })
    this.compose.append(this.refusal, this.input, this.hint)
    this.footer.append(this.compose, this.off)
    this.back.type = 'button'
    this.back.setAttribute('aria-label', 'Back to the conversation')
    this.back.title = 'Back to the conversation'
    this.back.innerHTML = icon('arrow-left', 16)
    this.back.addEventListener('click', () => o.back())
    this.state.append(this.mark, this.stateText)
    const head = el('div', 'agent-head')
    head.append(this.back, this.type, this.desc, this.state)
    this.wait.type = 'button'
    this.wait.hidden = true
    this.wait.append('Claude is waiting for your answer · ', el('strong', '', 'Back to the conversation'))
    this.wait.addEventListener('click', () => o.backToCard())
    this.column = new AgentColumn(o.cb, o.older)
    const body = el('div', 'agent-body')
    body.append(this.column.element, el('div', 'agent-fade'), this.column.pill)
    this.element.append(head, this.wait, body)
  }

  /** the bar under the header shows while the main conversation waits for an answer; it takes the focus when it appears on the page */
  setWaiting(waiting: boolean): void {
    if (this.wait.hidden === !waiting) return
    const onPage = this.element.contains(document.activeElement)
    this.wait.hidden = !waiting
    if (waiting && onPage) this.wait.focus()
  }

  /** the column Find searches while the page shows */
  findView(): FindView {
    return this.column
  }

  /** the agent's snapshot: the page holds it instead of what it held */
  load(s: AgentSnapshot): void {
    this.rev = s.rev
    this.agent = s.agent
    this.writable = s.writable
    this.column.setItems(s.items, s.agent.state === 'running', s.hasOlder)
    this.fillHeader()
    this.syncFooter()
    this.syncClock()
  }

  /** the chat exited or runs again: a page that is open shows the line that says a message cannot go */
  setChatExited(exited: boolean): void {
    this.exited = exited
    this.syncFooter()
  }

  /** whether a node is in the page or in its footer: the keys of the page are the same in both */
  owns(node: Node): boolean {
    return this.element.contains(node) || this.footer.contains(node)
  }

  /** the agent's patches: a batch the page has is ignored, one that straddles its revision is applied past it; false on a gap */
  patch(fromRev: number, toRev: number, patches: AgentPatch[]): boolean {
    const accept = acceptPatches(this.rev, fromRev, toRev, patches.length)
    if (accept.kind === 'gap') return false
    if (accept.kind === 'ignore') return true
    for (const p of patches.slice(accept.skip)) {
      if (p.op === 'agent') this.setAgent(p.agent)
      else this.column.apply(p)
    }
    this.rev = toRev
    return true
  }

  show(visible: boolean): void {
    this.visible = visible
    this.column.show(visible)
    if (visible) this.fillHeader()
    this.syncClock()
  }

  focus(): void {
    this.element.focus()
  }

  /** the chat cleared a draft that was sent: the field empties when it still shows that draft */
  clearSent(draft: string): void {
    if (this.input.value === draft) this.input.value = ''
  }

  dispose(): void {
    this.disposed = true
    this.stopClock()
    this.column.dispose()
    this.element.remove()
    this.footer.remove()
  }

  private setAgent(agent: ChatAgentInfo): void {
    this.agent = agent
    this.column.setRunning(agent.state === 'running')
    this.fillHeader()
    this.syncClock()
  }

  /** the header as the agent is now: its type and description, its mark for the state, and the state's text */
  private fillHeader(): void {
    const a = this.agent
    if (a === null) return
    setText(this.type, a.type)
    setText(this.desc, a.description)
    this.state.dataset.state = a.state
    setText(this.hint, a.state === 'stopped' ? STOPPED_HINT : WRITE_HINT)
    this.input.placeholder = `Message the ${a.type} agent…`
    if (this.markState !== a.state) {
      this.markState = a.state
      this.mark.replaceChildren()
      if (a.state === 'running') this.mark.append(el('span', 'chat-ring'))
      else this.mark.innerHTML = icon(a.state === 'done' ? 'check' : 'x', 13)
    }
    this.tick()
  }

  /** sends the box's text: a refusal shows under the field and the draft stays; a sent message clears the field */
  private async submit(o: AgentPageOptions): Promise<void> {
    const draft = this.input.value
    const text = draft.trim()
    if (text === '' || this.sending) return
    this.sending = true
    let refusal: string | null
    try {
      refusal = await o.send(text)
    } catch {
      refusal = NOT_REACHED
    } finally {
      this.sending = false
    }
    // a page closed while the message went touches no DOM: the chat clears the draft if it was sent, and a refusal is dropped
    if (this.disposed) {
      if (refusal === null) o.sent(draft)
      return
    }
    if (refusal !== null) {
      setText(this.refusal, refusal)
      this.refusal.hidden = false
      return
    }
    this.refusal.hidden = true
    // the chat clears the field too when it still shows the draft that was sent; a message typed while this one went stays
    o.sent(draft)
  }

  /** the message box while writing is on; one line in its place when it is off: a member's device reads the host's agent, and a chat that exited takes no message. Off, the box leaves the page (no field to type in), and it comes back with the writing */
  private syncFooter(): void {
    const off = this.readOnly ? OFF_MEMBER : this.exited || !this.writable ? OFF_EXITED : null
    if (off === null && !this.compose.isConnected) this.footer.insertBefore(this.compose, this.off)
    if (off !== null) {
      // the box held the focus: it goes to the page, or the focus falls to the body and Esc no longer reaches the chat's listener
      if (this.compose.contains(document.activeElement)) this.element.focus()
      this.compose.remove()
    }
    this.off.hidden = off === null
    setText(this.off, off ?? '')
  }

  private tick(): void {
    if (this.agent !== null) setText(this.stateText, agentStateText(this.agent, Date.now()))
  }

  private syncClock(): void {
    const run = this.visible && this.agent?.state === 'running'
    if (run && this.clock === null) this.clock = setInterval(() => this.tick(), 1000)
    if (!run) this.stopClock()
  }

  private stopClock(): void {
    if (this.clock !== null) clearInterval(this.clock)
    this.clock = null
  }
}
