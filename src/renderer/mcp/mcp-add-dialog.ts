// The "Add an MCP server" dialog of the MCP · Plugins panel: one paste field that reads a `claude mcp add` command, a server URL, a
// JSON config or a GitHub link, shows what will be added with its secrets masked, and adds it through Claude Code's CLI

import type { McpAddRequest, McpEditScope, McpResult } from '../../shared/mcp'
import { isServerName, maskText, parseAddInput, previewRows, secretsOf, type AddParse, type ParsedServer } from '../../shared/mcp-add'
import { el } from '../dom'

export interface AddDialogOptions {
  tabId: string
  /** adds the text's servers under the names and in the scope chosen; the answer is main's */
  add(req: McpAddRequest): Promise<McpResult>
  /** a GitHub link: its repository is added as a plugin marketplace */
  addMarketplace(source: string): void
  /** the servers were added: the panel asks its list again */
  done(): void
}

const SCOPES: { scope: McpEditScope; title: string; line: string }[] = [
  { scope: 'user', title: 'All my projects', line: 'Only on this computer, in every folder' },
  { scope: 'project', title: 'This project, shared', line: 'Saved in .mcp.json, for everyone on the repo' },
  { scope: 'local', title: 'This project, only me', line: 'This folder, on this computer' }
]
const FIELD_LABEL = 'Paste a command, a server URL or a JSON config'
const NAME_HINT = 'Use letters, digits, -, _ or . (up to 64)'
const DUPLICATE_HINT = 'Two servers have the same name'
const RESTART_NOTE = '↻ The session restarts and the conversation goes on'
/** the answer when the add itself failed: the dialog shows it like any other error */
const FAILED = 'The action did not finish'

/** the secrets of the servers a text adds: header values, env values and a URL's password */
function secretsIn(parsed: AddParse | null): string[] {
  return parsed?.kind === 'servers' ? parsed.servers.flatMap((s) => secretsOf(s.config)) : []
}

export function openAddDialog(o: AddDialogOptions): void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  // a recognised text with secrets lives only here: the field is emptied and hidden, and the masked view never shows it
  let held: string | null = null
  let names: string[] = []
  let lastText = ''
  let scope: McpEditScope = 'user'
  let shown: AddParse | null = null
  let nameHints: HTMLElement[] = []
  let busy = false
  let error = ''

  const field = el('textarea', { id: 'mcp-add-field', className: 'mcp-add-field', rows: 3, spellcheck: false })
  const maskedText = el('div', { className: 'mcp-add-masked-text' })
  const clear = el('button', { className: 'mcp-btn ghost', type: 'button', textContent: 'Clear' })
  const masked = el('div', { className: 'mcp-add-masked' }, maskedText, clear)
  const entry = el('div', { className: 'mcp-add-entry' }, el('label', { className: 'mcp-add-label', htmlFor: 'mcp-add-field', textContent: FIELD_LABEL }), field, masked)
  const found = el('div', { className: 'mcp-add-found' })
  const reason = el('div', { className: 'mcp-add-reason' })
  const secret = el('input', { id: 'mcp-add-secret', className: 'mcp-add-name', type: 'password', spellcheck: false })
  const secretRow = el('div', { className: 'mcp-add-server' }, el('label', { className: 'mcp-add-label', htmlFor: 'mcp-add-secret', textContent: 'OAuth client secret' }), secret)
  const scopeLabel = el('div', { className: 'mcp-add-label', id: 'mcp-add-where', textContent: 'Where it works' })
  const scopeButtons = SCOPES.map(({ scope: value, title, line }) => {
    const b = el('button', { className: 'mcp-add-scope', type: 'button' }, el('span', { className: 'mcp-add-scope-title', textContent: title }), el('span', { className: 'mcp-add-scope-line', textContent: line }))
    b.setAttribute('role', 'radio')
    b.dataset.scope = value
    b.addEventListener('click', () => choose(value))
    b.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
      if (step === 0) return
      e.preventDefault()
      const next = (SCOPES.findIndex((s) => s.scope === value) + step + SCOPES.length) % SCOPES.length
      choose(SCOPES[next].scope)
      scopeButtons[next].focus()
    })
    return b
  })
  const scopes = el('div', { className: 'mcp-add-scopes' }, ...scopeButtons)
  scopes.setAttribute('role', 'radiogroup')
  scopes.setAttribute('aria-labelledby', 'mcp-add-where')
  const closeButton = el('button', { className: 'mcp-ghost', type: 'button', textContent: '✕' })
  closeButton.setAttribute('aria-label', 'Close')
  const note = el('span', { className: 'mcp-add-note', textContent: RESTART_NOTE })
  const cancel = el('button', { className: 'mcp-btn ghost', type: 'button', textContent: 'Cancel' })
  const addButton = el('button', { className: 'mcp-btn primary', type: 'button' })
  const errorBox = el('div', { className: 'mcp-add-error' })

  const title = el('h2', { className: 'mcp-add-title', id: 'mcp-add-title', textContent: 'Add an MCP server' })
  const dialog = el('div', { className: 'mcp-add' },
    el('div', { className: 'mcp-add-head' }, title, closeButton),
    el('div', { className: 'mcp-add-body' }, entry, found, reason, secretRow, scopeLabel, scopes),
    el('div', { className: 'mcp-add-bottom' }, el('div', { className: 'mcp-add-actions' }, note, cancel, addButton), errorBox))
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'mcp-add-title')
  const scrim = el('div', { className: 'mcp-add-scrim' }, dialog)

  function close(): void {
    scrim.remove()
    if (opener?.isConnected) opener.focus()
  }

  function current(): string {
    return held ?? field.value
  }

  /** on a paste and on blur: a recognised text with secrets moves into memory; the field is emptied. True when it moved. */
  function holdIfSecret(): boolean {
    if (secretsIn(parseAddInput(field.value)).length === 0) return false
    held = field.value
    field.value = ''
    return true
  }

  function choose(value: McpEditScope): void {
    scope = value
    paintScopes()
  }

  function paintScopes(): void {
    for (const b of scopeButtons) {
      const on = b.dataset.scope === scope
      b.setAttribute('aria-checked', String(on))
      b.tabIndex = on ? 0 : -1
    }
  }

  /** the whole view as the text says: the field or the masked view, the recognised box, the reason, the scope and the buttons */
  function render(): void {
    const text = current()
    const parsed = text.trim() === '' ? null : parseAddInput(text)
    if (text !== lastText) {
      lastText = text
      names = parsed?.kind === 'servers' ? parsed.servers.map((s) => s.name) : []
      if (parsed?.kind === 'servers' && parsed.scope !== null) scope = parsed.scope
      error = ''
    }
    shown = parsed
    field.hidden = held !== null
    masked.hidden = held === null
    if (held !== null) maskedText.textContent = maskText(held, secretsIn(parsed))
    paintFound(parsed)
    paintScopes()
    refreshButtons()
    errorBox.textContent = error
  }

  function paintFound(parsed: AddParse | null): void {
    found.replaceChildren()
    nameHints = []
    found.hidden = parsed === null || parsed.kind === 'none'
    reason.hidden = parsed?.kind !== 'none'
    reason.textContent = parsed?.kind === 'none' ? parsed.reason : ''
    const servers = parsed?.kind === 'servers' ? parsed.servers : null
    secretRow.hidden = !(parsed?.kind === 'servers' && parsed.needsClientSecret)
    scopeLabel.hidden = servers === null
    scopes.hidden = servers === null
    if (parsed?.kind === 'github') {
      const source = parsed.source
      const addMarketplace = el('button', { className: 'mcp-btn', type: 'button', textContent: 'Add as a plugin marketplace' })
      addMarketplace.addEventListener('click', () => {
        o.addMarketplace(source)
        close()
      })
      found.append(el('div', { className: 'mcp-add-found-head', textContent: `This is a GitHub repository: ${source}` }), addMarketplace)
    }
    if (servers !== null) {
      found.append(el('div', { className: 'mcp-add-found-head', textContent: '✓ Recognized' }))
      servers.forEach((server, i) => found.append(serverBlock(server, i)))
    }
  }

  /** a server: its name (editable, checked), and what will be added with its secrets masked */
  function serverBlock(server: ParsedServer, i: number): HTMLElement {
    const id = `mcp-add-name-${i}`
    const input = el('input', { id, className: 'mcp-add-name', type: 'text', value: names[i] ?? server.name, spellcheck: false })
    input.addEventListener('input', () => {
      names[i] = input.value
      refreshButtons()
    })
    const hint = el('div', { className: 'mcp-add-hint' })
    nameHints[i] = hint
    const rows = previewRows(server).map((r) => el('div', { className: 'mcp-add-row' }, el('span', { className: 'mcp-add-key', textContent: r.label }), el('span', { className: 'mcp-add-value', textContent: r.value })))
    return el('div', { className: 'mcp-add-server' }, el('label', { className: 'mcp-add-label', htmlFor: id, textContent: 'Name' }), input, hint, el('div', { className: 'mcp-add-rows' }, ...rows))
  }

  /** the name hints, and Add: enabled only with valid, different names and, when asked, a client secret */
  function refreshButtons(): void {
    const servers = shown?.kind === 'servers' ? shown.servers : []
    nameHints.forEach((hint, i) => {
      const name = names[i] ?? ''
      hint.textContent = !isServerName(name) ? NAME_HINT : names.some((other, j) => j !== i && other === name) ? DUPLICATE_HINT : ''
    })
    const needsSecret = shown?.kind === 'servers' && shown.needsClientSecret
    const valid = servers.length > 0 && names.every((name) => isServerName(name)) && new Set(names).size === names.length && (!needsSecret || secret.value !== '')
    addButton.disabled = busy || !valid
    addButton.textContent = busy ? 'Adding…' : servers.length > 1 ? `Add ${servers.length} servers and restart` : 'Add and restart'
  }

  field.addEventListener('input', () => render())
  // a paste: the text is taken as pasted, a recognised secret moves out of the field at once
  field.addEventListener('paste', (e) => {
    e.preventDefault()
    field.setRangeText(e.clipboardData?.getData('text/plain') ?? '', field.selectionStart, field.selectionEnd, 'end')
    const holding = holdIfSecret()
    render()
    if (holding) clear.focus()
  })
  field.addEventListener('blur', () => {
    if (holdIfSecret()) render()
  })
  clear.addEventListener('click', () => {
    held = null
    field.value = ''
    render()
    field.focus()
  })
  secret.addEventListener('input', () => refreshButtons())
  addButton.addEventListener('click', () => {
    if (shown?.kind !== 'servers' || addButton.disabled) return
    const req: McpAddRequest = {
      text: current(),
      names: names.slice(0, shown.servers.length),
      scope,
      clientSecret: shown.needsClientSecret ? secret.value : null
    }
    busy = true
    error = ''
    render()
    o.add(req)
      .catch((): McpResult => ({ ok: false, error: FAILED }))
      .then((result) => {
        busy = false
        if (result.ok) {
          close()
          o.done()
          return
        }
        error = result.error
        render()
      })
  })
  closeButton.addEventListener('click', close)
  cancel.addEventListener('click', close)
  // Esc closes; Tab stays inside the dialog
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key !== 'Tab') return
    const stops = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, textarea'))
      .filter((n) => !n.hasAttribute('disabled') && n.tabIndex >= 0 && n.getClientRects().length > 0)
    if (stops.length === 0) return
    const first = stops[0]
    const last = stops[stops.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault()
      first.focus()
    }
  })

  render()
  document.body.append(scrim)
  field.focus()
}
