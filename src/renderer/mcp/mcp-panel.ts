import type { McpAction, McpAddRequest, McpResult, McpSection, McpServersView, McpServerView, PluginAction, PluginsView } from '../../shared/mcp'
import { el } from '../dom'
import type { SidePanel } from '../side-panel'
import { serverList, type RowCommand, type RowState } from './mcp-servers'
import { editScope, serverStats } from './mcp-view-model'
import './mcp.css'

export interface McpPanelCallbacks {
  /** the servers of a tab's session and configuration; null for a tab that is not a local Claude tab */
  servers(tabId: string): Promise<McpServersView | null>
  action(tabId: string, a: McpAction): Promise<McpResult>
  add(tabId: string, req: McpAddRequest): Promise<McpResult>
  plugins(tabId: string): Promise<PluginsView | { error: string } | null>
  pluginAction(tabId: string, a: PluginAction): Promise<McpResult>
  /** the Approve button of a server that waits for approval in the terminal (the row actions) */
  approve(tabId: string): void
}

/** how long a server that is connecting waits before the panel asks for its status again */
const PENDING_MS = 2000
const NOT_CLAUDE = 'Not a Claude tab of this computer'
const NOT_RUNNING = 'Claude Code is not running in this tab: statuses show once it runs'
/** the answer when the call itself failed: the row shows it like any other error */
const FAILED: McpResult = { ok: false, error: 'The action did not finish' }
const SECTIONS: Record<McpSection, { label: string; hint: string }> = {
  servers: { label: 'MCP servers', hint: 'Changes restart the session' },
  plugins: { label: 'Plugins', hint: 'Installs and changes restart the session' }
}

type Plugins = PluginsView | { error: string } | null

/**
 * The MCP · Plugins panel: the servers the chat's Claude Code loads, and the plugins. It shows the tab in front's servers; the
 * servers are asked of main when the panel shows them, and again every few seconds while one connects.
 */
export class McpPanel {
  private tabId: string | null = null
  private section: McpSection = 'servers'
  private filter = ''
  /** the rows whose tools are open */
  private readonly unfolded = new Set<string>()
  /** what each row keeps, per tab and server: a sign-in waiting, an action running, its error, a removal asked for */
  private readonly rows = new Map<string, RowState>()
  /** the server whose ··· menu is open */
  private menuOf: string | null = null
  /** undefined while the answer is asked for: the panel says Loading */
  private servers: McpServersView | null | undefined = undefined
  private plugins: Plugins | undefined = undefined
  /** the latest load: an answer to an older one that comes later is dropped */
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  /** the filter asked for the focus while the panel was hidden: it takes it once the panel is drawn */
  private focusWanted = false
  private readonly top = el('div', { className: 'mcp-top' })
  private readonly segments: HTMLButtonElement[] = []
  private readonly counts: Record<McpSection, HTMLSpanElement> = { servers: el('span', { className: 'mcp-count' }), plugins: el('span', { className: 'mcp-count' }) }
  private readonly stats = el('div', { className: 'mcp-stats' })
  private readonly note = el('div', { className: 'mcp-note' })
  private readonly filterBox = el('input', { className: 'mcp-filter', type: 'text', placeholder: 'Filter servers and tools' })
  private readonly list = el('div', { className: 'mcp-list' })
  private readonly hint = el('span', { className: 'mcp-hint' })
  private readonly footer = el('div', { className: 'mcp-footer' }, el('button', { className: 'mcp-btn primary', type: 'button', textContent: '＋ Add server' }), this.hint)

  constructor(private readonly body: HTMLElement, private readonly panel: SidePanel, private readonly cb: McpPanelCallbacks) {
    for (const section of ['servers', 'plugins'] as const) {
      const b = el('button', { className: 'mcp-seg-btn', type: 'button', textContent: SECTIONS[section].label })
      b.dataset.section = section
      b.append(this.counts[section])
      b.addEventListener('click', () => this.select(section))
      this.segments.push(b)
    }
    this.top.append(el('div', { className: 'mcp-seg' }, ...this.segments), this.stats, this.note, this.filterBox)
    this.filterBox.addEventListener('input', () => {
      this.filter = this.filterBox.value
      this.paint()
    })
    // Esc clears the filter; with no filter it is left to the rest of the window
    this.filterBox.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.filter === '') return
      e.preventDefault()
      this.filter = ''
      this.filterBox.value = ''
      this.paint()
    })
    // a click outside the open ··· menu closes it; the ··· button of a row toggles its own menu, so it is not a click outside
    document.addEventListener('pointerdown', (e) => {
      if (this.menuOf === null) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('.mcp-menu, [data-focus-key="more"]')) return
      this.closeMenu(false)
    })
    this.body.replaceChildren(this.top, this.list, this.footer)
    // a panel that opens is collapsed until its slide starts: the body's first size is when the filter can take the focus
    new ResizeObserver(() => this.takeFocus()).observe(this.body)
    this.paint()
  }

  /** the tab in front: its servers and plugins are the ones the panel shows */
  show(tabId: string | null): void {
    if (tabId !== this.tabId) {
      this.tabId = tabId
      this.servers = undefined
      this.plugins = undefined
      this.menuOf = null
    }
    this.refresh()
  }

  /** the panel opens on a section: the servers, or the plugins (the /mcp and /plugin commands) */
  open(section: McpSection): void {
    this.section = section
    this.paint()
    void this.load()
  }

  /** asks again while the panel shows the tab's servers or plugins: after a change of the servers, a tab switch or the panel's opening */
  refresh(): void {
    if (!this.panel.isShowing('mcp')) {
      this.clearTimer()
      return
    }
    void this.load()
  }

  /** the filter takes the focus: only the servers have one (the plugins section hides it) */
  focusFilter(): void {
    this.focusWanted = this.section === 'servers'
    this.takeFocus()
  }

  /** the filter takes the focus it asked for, once it is drawn: a hidden panel or a hidden filter takes none */
  private takeFocus(): void {
    if (!this.focusWanted || this.filterBox.offsetParent === null) return
    this.focusWanted = false
    this.filterBox.focus()
  }

  private select(section: McpSection): void {
    if (section === this.section) return
    this.section = section
    this.paint()
    void this.load()
  }

  private async load(): Promise<void> {
    this.clearTimer()
    const tabId = this.tabId
    const seq = ++this.seq
    if (tabId === null) {
      this.servers = null
      this.plugins = null
      this.paint()
      return
    }
    if (this.section === 'servers') {
      const view = await this.cb.servers(tabId).catch(() => null)
      if (seq !== this.seq) return
      this.servers = view
      this.paint()
      // a server that connects is asked for again, until it has an answer
      if (view !== null && view.servers.some((s) => s.status === 'pending')) this.timer = setTimeout(() => this.refresh(), PENDING_MS)
    } else {
      const view = await this.cb.plugins(tabId).catch(() => null)
      if (seq !== this.seq) return
      this.plugins = view
      this.paint()
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** a control of a row was used: the panel runs it, and the row shows the wait and the answer */
  private command(s: McpServerView, c: RowCommand): void {
    const tabId = this.tabId
    if (tabId === null) return
    const row = this.rowOf(s.name)
    switch (c) {
      case 'sign-in':
        this.signIn(tabId, s.name, row)
        return
      case 'cancel-sign-in':
        row.cancelled = true
        void this.request(tabId, { kind: 'cancel-login', name: s.name })
        return
      case 'reconnect':
        this.run(tabId, row, { kind: 'reconnect', name: s.name })
        return
      case 'toggle':
        this.run(tabId, row, { kind: 'toggle', name: s.name, enabled: s.status === 'disabled' })
        return
      case 'approve':
        this.cb.approve(tabId)
        return
      case 'menu':
        this.menuOf = this.menuOf === s.name ? null : s.name
        this.paint()
        if (this.menuOf !== null) this.rowNode(s.name)?.querySelector<HTMLElement>('.mcp-menu-item')?.focus()
        return
      case 'close-menu':
        this.closeMenu(true)
        return
      case 'sign-out':
        this.menuOf = null
        this.run(tabId, row, { kind: 'logout', name: s.name })
        return
      case 'tools':
        this.menuOf = null
        this.fold(s.name)
        this.focusControl(s.name, 'more')
        return
      case 'copy-config': {
        const scope = editScope(s)
        this.menuOf = null
        if (scope !== null) this.run(tabId, row, { kind: 'copy-config', name: s.name, scope })
        return
      }
      case 'open-config': {
        const scope = editScope(s)
        this.menuOf = null
        if (scope !== null) this.run(tabId, row, { kind: 'open-config', scope })
        return
      }
      case 'ask-remove':
        this.menuOf = null
        row.asking = true
        this.paint()
        return
      case 'cancel-remove':
        row.asking = false
        this.paint()
        return
      case 'remove': {
        const scope = editScope(s)
        if (scope === null) return
        row.asking = false
        this.run(tabId, row, { kind: 'remove', name: s.name, scope })
        return
      }
    }
  }

  /** the browser sign-in: the row waits for it, and Cancel ends it; its Cancelled answer is no error */
  private signIn(tabId: string, name: string, row: RowState): void {
    row.signingIn = true
    row.cancelled = false
    row.error = null
    this.paint()
    void this.request(tabId, { kind: 'login', name }).then((result) => {
      row.signingIn = false
      if (!result.ok && !row.cancelled) row.error = result.error
      else row.error = null
      row.cancelled = false
      this.settled(tabId)
    })
  }

  /** an action of a row: its controls wait for the answer, and a failure is the row's error until its next action */
  private run(tabId: string, row: RowState, a: McpAction): void {
    row.busy = true
    row.error = null
    this.paint()
    void this.request(tabId, a).then((result) => {
      row.busy = false
      row.error = result.ok ? null : result.error
      this.settled(tabId)
    })
  }

  private request(tabId: string, a: McpAction): Promise<McpResult> {
    return this.cb.action(tabId, a).catch((): McpResult => FAILED)
  }

  /** an answer came: the row shows it and the list is asked again; a tab that is no longer in front keeps its rows as they are */
  private settled(tabId: string): void {
    if (this.tabId !== tabId) return
    this.paint()
    void this.load()
  }

  /** what a row keeps for the tab in front */
  private rowOf(name: string): RowState {
    const key = JSON.stringify([this.tabId ?? '', name])
    const kept = this.rows.get(key)
    if (kept !== undefined) return kept
    const row: RowState = { busy: false, signingIn: false, cancelled: false, asking: false, error: null }
    this.rows.set(key, row)
    return row
  }

  /** the ··· menu closes; its ··· button gets the focus back when the close is asked for by the keyboard */
  private closeMenu(focusMore: boolean): void {
    const name = this.menuOf
    this.menuOf = null
    this.paint()
    if (focusMore && name !== null) this.focusControl(name, 'more')
  }

  /** the panel as its state says: the segments with their counts, the stats or the note, the filter, the list and the footer */
  private paint(): void {
    const servers = this.section === 'servers'
    for (const b of this.segments) b.setAttribute('aria-pressed', String(b.dataset.section === this.section))
    this.counts.servers.textContent = this.servers ? String(this.servers.servers.length) : ''
    this.counts.plugins.textContent = this.plugins && isView(this.plugins) ? String(this.plugins.installed.length) : ''
    this.hint.textContent = SECTIONS[this.section].hint
    const current = servers ? this.servers : this.plugins
    // no tab that is a local Claude tab: the panel shows the note and nothing else
    const notClaude = current === null || this.tabId === null
    this.note.classList.remove('mcp-note-error')
    this.setShown(this.segments[0].parentElement!, !notClaude)
    this.setShown(this.stats, false)
    this.setShown(this.filterBox, !notClaude && servers)
    this.setShown(this.list, !notClaude)
    this.setShown(this.footer, !notClaude)
    if (notClaude) {
      this.note.textContent = NOT_CLAUDE
      this.setShown(this.note, true)
      this.setList()
      return
    }
    if (servers) this.paintServers()
    else this.paintPlugins()
  }

  private paintServers(): void {
    const view = this.servers
    if (view === undefined) {
      this.note.textContent = 'Loading…'
      this.setShown(this.note, true)
      this.setList()
      return
    }
    if (view === null) return
    if (view.live) {
      const stats = serverStats(view)
      this.stats.replaceChildren(
        stat(stats.connected, 'connected', 'green'),
        stat(stats.needSignIn, 'need sign-in', 'amber'),
        stat(stats.failed, 'failed', 'red')
      )
      this.setShown(this.stats, true)
      this.setShown(this.note, false)
    } else {
      this.note.textContent = NOT_RUNNING
      this.note.classList.remove('mcp-note-error')
      this.setShown(this.note, true)
    }
    this.setList(...serverList(view, {
      filter: this.filter,
      unfolded: this.unfolded,
      fold: (name) => this.fold(name),
      state: (name) => this.rowOf(name),
      menu: this.menuOf,
      command: (s, c) => this.command(s, c)
    }))
  }

  /** the plugins: the section is filled by the plugin list; until then it says Loading, and a failed read says why */
  private paintPlugins(): void {
    const view = this.plugins
    if (view === undefined) {
      this.note.textContent = 'Loading plugins…'
      this.setShown(this.note, true)
    } else if (view !== null && !isView(view)) {
      this.note.textContent = view.error
      this.note.classList.add('mcp-note-error')
      this.setShown(this.note, true)
    } else {
      this.setShown(this.note, false)
    }
    this.setList()
  }

  /** the list is drawn again: the control that had the focus is drawn again too, found by its row and its focus key */
  private setList(...nodes: Node[]): void {
    const active = document.activeElement
    const kept = active instanceof HTMLElement && this.list.contains(active) ? focusKeyOf(active) : null
    this.list.replaceChildren(...nodes)
    if (kept === null) return
    Array.from(this.list.querySelectorAll<HTMLElement>('[data-focus-key]')).find((c) => focusKeyOf(c) === kept)?.focus()
  }

  /** the control of a row with this focus key gets the focus, once the list is drawn */
  private focusControl(name: string, key: string): void {
    const wanted = JSON.stringify([name, key])
    Array.from(this.list.querySelectorAll<HTMLElement>('[data-focus-key]')).find((c) => focusKeyOf(c) === wanted)?.focus()
  }

  private rowNode(name: string): HTMLElement | null {
    return Array.from(this.list.querySelectorAll<HTMLElement>('.mcp-item')).find((n) => n.dataset.name === name) ?? null
  }

  private fold(name: string): void {
    if (this.unfolded.has(name)) this.unfolded.delete(name)
    else this.unfolded.add(name)
    this.paint()
  }

  private setShown(el: HTMLElement, shown: boolean): void {
    el.hidden = !shown
  }
}

/** a row's control as a key a repaint finds again: its row's name and its focus key; null for an element that has neither */
function focusKeyOf(control: HTMLElement): string | null {
  const row = control.closest<HTMLElement>('[data-name]')
  const key = control.dataset.focusKey
  return row && key ? JSON.stringify([row.dataset.name, key]) : null
}

function isView(p: PluginsView | { error: string }): p is PluginsView {
  return 'installed' in p
}

function stat(n: number, label: string, tone: 'green' | 'amber' | 'red'): HTMLElement {
  return el('div', { className: 'mcp-stat' }, el('span', { className: `mcp-stat-value ${tone}`, textContent: String(n) }), el('span', { className: 'mcp-stat-label', textContent: label }))
}
