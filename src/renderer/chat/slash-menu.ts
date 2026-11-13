import type { ChatCommandInfo } from '../../shared/chat'

export type SlashRoute = { to: 'native'; name: 'model' | 'resume' | 'mcp' | 'plugin' } | { to: 'terminal'; line: string } | { to: 'send'; text: string }

/** the built-ins that need the terminal: Claude Code's own dialogs and settings, which the chat does not draw */
const TERMINAL_BUILTINS = new Set(['config', 'permissions', 'agents', 'login', 'logout', 'doctor', 'rewind', 'terminal-setup', 'ide', 'vim', 'statusline', 'exit'])
/** the groups of the menu, in their order */
const GROUPS: { group: ChatCommandInfo['group']; label: string }[] = [
  { group: 'builtin', label: 'Claude Code' },
  { group: 'project', label: 'This project' },
  { group: 'plugin', label: 'Plugins and skills' }
]
const TAG = 'Opens in the terminal'
const HINT = '↑↓ move · Tab complete · Enter run'

/**
 * Where a composer text that starts with / or ! goes: /model, /resume, /mcp and /plugin (or /plugins) without arguments are answered
 * by the app, the terminal's commands, the commands answered "not available" before (`unavailable`, their names) and a ! line go
 * to the terminal with the whole text, and everything else is sent to Claude Code.
 */
export function routeSlash(text: string, commands: ChatCommandInfo[], unavailable: readonly string[] = []): SlashRoute {
  if (text.startsWith('!')) return { to: 'terminal', line: text }
  if (!text.startsWith('/')) return { to: 'send', text }
  const space = text.search(/\s/)
  const name = text.slice(1, space === -1 ? undefined : space)
  const args = space === -1 ? '' : text.slice(space).trim()
  if (args === '' && (name === 'model' || name === 'resume' || name === 'mcp')) return { to: 'native', name }
  if (args === '' && (name === 'plugin' || name === 'plugins')) return { to: 'native', name: 'plugin' }
  const terminal = TERMINAL_BUILTINS.has(name) || unavailable.includes(name) || commands.some((c) => c.name === name && c.terminal)
  if (terminal) return { to: 'terminal', line: text }
  return { to: 'send', text }
}

export interface SlashMenuOptions {
  /** the chat's commands, asked for each time the menu opens: the composer's list, which its routing uses too */
  commands(): Promise<ChatCommandInfo[]>
  /** whether a command goes to the terminal, tagged in the menu */
  terminal(name: string): boolean
  /** whether the app answers a command without arguments (/model, /resume, /mcp, /plugin): Enter runs it even when the command takes arguments */
  native(name: string): boolean
  /** Tab, or Enter on a command that takes arguments: the composer's text becomes this, and waits for the rest */
  complete(text: string): void
  /** Enter on a command that takes no arguments, or a click on it: the command runs */
  run(name: string): void
}

/** the positions of the query's letters in the name, in order (greedy); null when they do not all come in order */
function matchAt(name: string, query: string): number[] | null {
  const found: number[] = []
  const lower = name.toLowerCase()
  let from = 0
  for (const letter of query.toLowerCase()) {
    const at = lower.indexOf(letter, from)
    if (at < 0) return null
    found.push(at)
    from = at + 1
  }
  return found
}

/** the name as nodes: the matched letters in <mark> elements, a run of them in one mark; built with DOM nodes only */
function nameNodes(name: string, at: number[] | null): Node[] {
  const marked = new Set(at ?? [])
  const nodes: Node[] = []
  let i = 0
  while (i < name.length) {
    const hit = marked.has(i)
    let j = i
    while (j < name.length && marked.has(j) === hit) j++
    const piece = name.slice(i, j)
    if (hit) {
      const mark = document.createElement('mark')
      mark.textContent = piece
      nodes.push(mark)
    } else {
      nodes.push(document.createTextNode(piece))
    }
    i = j
  }
  return nodes
}

/**
 * The slash menu above the composer: the commands the chat has, in their groups, filtered by the letters typed after the
 * slash. ↑↓ move, Tab completes the name, Enter runs it (or completes it and waits when it takes arguments), Esc closes.
 */
export class SlashMenu {
  readonly element: HTMLDivElement
  private readonly count: HTMLDivElement
  private readonly list: HTMLDivElement
  private commands: ChatCommandInfo[] = []
  /** the commands that match the query, in the order of the menu */
  private shown: { command: ChatCommandInfo; at: number[] | null }[] = []
  private query = ''
  private selected = 0
  private opened = false

  constructor(anchor: HTMLElement, private readonly o: SlashMenuOptions) {
    this.element = document.createElement('div')
    this.element.className = 'chat-slash-menu'
    this.element.hidden = true
    this.element.setAttribute('role', 'listbox')
    this.element.setAttribute('aria-label', 'Commands')
    const head = document.createElement('div')
    head.className = 'chat-slash-head'
    this.count = document.createElement('div')
    this.count.className = 'chat-slash-count'
    const hint = document.createElement('div')
    hint.className = 'chat-slash-hint-line'
    hint.textContent = HINT
    head.append(this.count, hint)
    this.list = document.createElement('div')
    this.list.className = 'chat-slash-list'
    this.element.append(head, this.list)
    anchor.append(this.element)
  }

  get isOpen(): boolean {
    return this.opened
  }

  /** shows the menu for the letters typed after the slash, loading the commands when the menu opens */
  update(query: string): void {
    if (!this.opened) {
      this.opened = true
      this.element.hidden = false
      void this.o.commands().then((list) => {
        if (list.length === 0) return
        this.commands = list
        if (this.opened) this.render()
      }, () => undefined)
    }
    this.query = query
    this.selected = 0
    this.render()
  }

  close(): void {
    this.opened = false
    this.element.hidden = true
  }

  /** the keys of the open menu; true when it took the key */
  key(e: KeyboardEvent): boolean {
    if (!this.opened) return false
    if (e.key === 'Escape') {
      this.close()
      return true
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (this.shown.length > 0) this.move(e.key === 'ArrowDown' ? 1 : -1)
      return this.shown.length > 0
    }
    // a name typed in full that the app answers (/mcp, /plugin) runs as typed: the menu's first match is not the command typed
    if (e.key === 'Enter' && !e.shiftKey && this.query !== '' && this.o.native(this.query)) {
      this.close()
      this.o.run(this.query)
      return true
    }
    const chosen = this.shown[this.selected]
    // Enter with no command to run closes the menu: the text goes on as a message, with no menu over the field
    if (chosen === undefined) {
      if (e.key === 'Enter' && !e.shiftKey) this.close()
      return false
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      this.complete(chosen.command)
      return true
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      this.choose(chosen.command)
      return true
    }
    return false
  }

  /** a command: completed with its name when it takes arguments, else run */
  private choose(command: ChatCommandInfo): void {
    if (command.argumentHint !== '' && !this.o.native(command.name)) this.complete(command)
    else {
      this.close()
      this.o.run(command.name)
    }
  }

  private complete(command: ChatCommandInfo): void {
    this.close()
    this.o.complete(`/${command.name} `)
  }

  private move(delta: number): void {
    this.selected = (this.selected + delta + this.shown.length) % this.shown.length
    this.render()
    this.list.querySelector('.chat-slash-row.selected')?.scrollIntoView({ block: 'nearest' })
  }

  private render(): void {
    this.shown = this.commands.flatMap((command): { command: ChatCommandInfo; at: number[] | null }[] => {
      if (this.query === '') return [{ command, at: null }]
      const at = matchAt(command.name, this.query)
      return at === null ? [] : [{ command, at }]
    })
    // the index order is the drawn order: the groups in their order, and within a group a name that starts with the letters typed comes first
    const rank = (c: ChatCommandInfo): number => GROUPS.findIndex((g) => g.group === c.group)
    const starts = (s: { at: number[] | null }): number => (s.at?.[0] === 0 ? 1 : 0)
    this.shown.sort((a, b) => rank(a.command) - rank(b.command) || starts(b) - starts(a))
    this.selected = Math.min(this.selected, Math.max(0, this.shown.length - 1))
    const n = this.shown.length
    this.count.textContent = this.query === ''
      ? `${n} ${n === 1 ? 'command' : 'commands'}`
      : n === 0 ? `No commands match "${this.query}"` : `${n} ${n === 1 ? 'command' : 'commands'} match "${this.query}"`
    const rows: HTMLElement[] = []
    for (const { group, label } of GROUPS) {
      const inGroup = this.shown.map((s, i) => ({ ...s, index: i })).filter((s) => s.command.group === group)
      if (inGroup.length === 0) continue
      const heading = document.createElement('div')
      heading.className = 'chat-slash-group'
      heading.textContent = label
      rows.push(heading, ...inGroup.map((s) => this.row(s.command, s.at, s.index)))
    }
    this.list.replaceChildren(...rows)
  }

  private row(command: ChatCommandInfo, at: number[] | null, index: number): HTMLElement {
    const row = document.createElement('div')
    row.className = `chat-slash-row${index === this.selected ? ' selected' : ''}`
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(index === this.selected))
    // the whole command, when its name is cut in the menu
    row.title = `/${command.name}${command.argumentHint !== '' ? ` ${command.argumentHint}` : ''} — ${command.description}`
    const name = document.createElement('span')
    name.className = 'chat-slash-name'
    name.append('/', ...nameNodes(command.name, at))
    if (command.argumentHint !== '') {
      const hint = document.createElement('span')
      hint.className = 'chat-slash-args'
      hint.textContent = ` ${command.argumentHint}`
      name.append(hint)
    }
    const desc = document.createElement('span')
    desc.className = 'chat-slash-desc'
    desc.textContent = command.description
    const side = document.createElement('span')
    side.className = 'chat-slash-side'
    if (command.group === 'plugin' && command.source !== null) {
      const source = document.createElement('span')
      source.className = 'chat-slash-source'
      source.textContent = command.source
      side.append(source)
    }
    if (this.o.terminal(command.name)) {
      const tag = document.createElement('span')
      tag.className = 'chat-slash-tag'
      tag.textContent = TAG
      side.append(tag)
    }
    row.append(name, desc, side)
    // a press keeps the focus where it was, in the composer
    row.addEventListener('mousedown', (e) => e.preventDefault())
    row.addEventListener('click', () => {
      this.selected = index
      this.choose(command)
    })
    return row
  }
}
