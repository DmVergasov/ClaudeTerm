// The Plugins section of the MCP · Plugins panel: the installed plugins with their switches and updates, the Discover cards with
// their installs, the marketplaces, and the settings a plugin with required options asks for after its install. The actions run
// through the panel's callbacks; a failure is the error under its row or card, never a toast.

import type { MarketplaceView, McpResult, PluginAction, PluginOffer, PluginOption, PluginView, PluginsView } from '../../shared/mcp'
import { el } from '../dom'
import { countLabel, iconColor, initials, pluginLine } from './mcp-view-model'

export interface PluginsCallbacks {
  /** a plugin or marketplace action of a tab; the answer is main's, and a call that failed is a failed answer */
  run(tabId: string, a: PluginAction): Promise<McpResult>
  /** the tab in front, or null: an answer for a tab that is no longer in front changes only its own lists */
  tab(): string | null
  /** an action changed the plugins: the panel asks the list again */
  changed(): void
  /** the section is drawn again from its state */
  repaint(): void
  /** the plugins section of this tab is on screen: a settings form that is not may not hold the session's restart */
  live(tabId: string): boolean
}

type SubTab = 'installed' | 'discover' | 'marketplaces'

const SUBS: SubTab[] = ['installed', 'discover', 'marketplaces']
const SUB_LABEL: Record<SubTab, string> = { installed: 'Installed', discover: 'Discover', marketplaces: 'Marketplaces' }
const NO_PLUGINS = 'No plugins installed'
const NO_DISCOVER = 'No plugins to discover: add a marketplace first'
const NO_MARKETS = 'No marketplaces added'
const ADD_TEXT = '＋ Add a marketplace: a GitHub link, a URL or a folder'

/** what a row or a card keeps: an action running, its error, a removal or an uninstall asked for */
interface ItemState {
  busy: boolean
  error: string | null
  asking: boolean
}

/** the settings form of a plugin installed with required options: its inputs hold the values until Save sends them, once */
interface OptionsForm {
  tabId: string
  id: string
  node: HTMLElement
  inputs: [string, HTMLInputElement][]
  error: HTMLElement
  save: HTMLButtonElement
  later: HTMLButtonElement
  busy: boolean
}

export class PluginsSection {
  private sub: SubTab = 'installed'
  /** the marketplace the Discover cards are filtered to, after a marketplace was added */
  private only: string | null = null
  private readonly unfolded = new Set<string>()
  /** what each row or card keeps, per tab: the plugin's id, or 'market:' and the marketplace's name */
  private readonly items = new Map<string, ItemState>()
  private form: OptionsForm | null = null
  private addOpen = false
  private addBusy = false
  private addError = ''
  private readonly bar = el('div', { className: 'mcp-subtabs' })
  private readonly subButtons: Record<SubTab, HTMLButtonElement>
  private readonly marketCount = el('span', { className: 'mcp-count' })
  private readonly addOpenButton = el('button', { className: 'mcp-market-add', type: 'button', textContent: ADD_TEXT })
  private readonly addField = el('input', { className: 'mcp-market-input', type: 'text', spellcheck: false, placeholder: 'a GitHub link, a URL or a folder' })
  private readonly addButton = el('button', { className: 'mcp-btn primary small', type: 'button', textContent: 'Add' })
  private readonly addForm = el('div', { className: 'mcp-market-form' }, this.addField, this.addButton)
  private readonly addErrorBox = el('div', { className: 'mcp-error' })

  constructor(private readonly cb: PluginsCallbacks) {
    const buttons = {} as Record<SubTab, HTMLButtonElement>
    for (const s of SUBS) {
      const b = el('button', { className: 'mcp-subtab', type: 'button', textContent: SUB_LABEL[s] })
      b.dataset.sub = s
      b.addEventListener('click', () => this.select(s))
      buttons[s] = b
    }
    this.subButtons = buttons
    this.subButtons.marketplaces.append(this.marketCount)
    this.bar.append(...SUBS.map((s) => this.subButtons[s]))
    this.addOpenButton.addEventListener('click', () => {
      this.addOpen = true
      this.cb.repaint()
      this.addField.focus()
    })
    this.addButton.dataset.focusKey = 'market-add'
    this.addButton.addEventListener('click', () => this.addSubmit(this.addField.value))
    this.addField.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      this.addSubmit(this.addField.value)
    })
  }

  /** the section as its state says, for the view of the tab in front */
  nodes(tabId: string, view: PluginsView): HTMLElement[] {
    this.marketCount.textContent = String(view.marketplaces.length)
    for (const s of SUBS) this.subButtons[s].setAttribute('aria-pressed', String(this.sub === s))
    const out: HTMLElement[] = [this.bar]
    if (this.form !== null) out.push(this.form.node)
    switch (this.sub) {
      case 'installed':
        out.push(...this.installed(tabId, view.installed))
        break
      case 'discover':
        out.push(...this.discover(tabId, view.available))
        break
      case 'marketplaces':
        out.push(...this.marketplaces(tabId, view.marketplaces))
        break
    }
    return out
  }

  /** the dialog's GitHub link: the Marketplaces add takes it, and its answer shows here like any add */
  addMarketplace(source: string): void {
    this.sub = 'marketplaces'
    this.addOpen = true
    this.addField.value = source
    this.addSubmit(source)
  }

  /** a settings form that goes away without Save: its plugin is told it is configured later, so the session's restart is not held */
  release(): void {
    const form = this.form
    if (form === null) return
    this.form = null
    void this.cb.run(form.tabId, { kind: 'configure-later', id: form.id })
  }

  private select(s: SubTab): void {
    if (s === this.sub) return
    this.sub = s
    this.cb.repaint()
    this.subButtons[s].focus()
  }

  private item(tabId: string, key: string): ItemState {
    const k = JSON.stringify([tabId, key])
    let state = this.items.get(k)
    if (state === undefined) {
      state = { busy: false, error: null, asking: false }
      this.items.set(k, state)
    }
    return state
  }

  /** an action of a row or a card: its controls wait for the answer, a failure is its error, a success asks the list again */
  private perform(tabId: string, key: string, a: PluginAction): void {
    const state = this.item(tabId, key)
    state.busy = true
    state.error = null
    this.cb.repaint()
    void this.cb.run(tabId, a).then((result) => {
      state.busy = false
      state.error = result.ok ? null : result.error
      if (result.ok) this.cb.changed()
      this.cb.repaint()
    })
  }

  private installed(tabId: string, list: PluginView[]): HTMLElement[] {
    if (list.length === 0) return [el('div', { className: 'mcp-empty', textContent: NO_PLUGINS })]
    return list.map((p) => this.installedRow(tabId, p))
  }

  /** an installed plugin: its icon, name and version line, the Update button when a newer one is in the marketplace, and its switch */
  private installedRow(tabId: string, p: PluginView): HTMLElement {
    const state = this.item(tabId, p.id)
    const open = this.unfolded.has(p.id)
    const item = el('div', { className: 'mcp-item mcp-plugin' })
    item.dataset.name = p.id
    const line = el('div', { className: 'mcp-row' })
    line.dataset.status = p.enabled ? 'connected' : 'disabled'
    const icon = el('span', { className: 'mcp-icon', textContent: initials(p.name) })
    if (p.enabled) icon.style.background = iconColor(p.name)
    const main = el('button', { className: 'mcp-main', type: 'button' })
    main.dataset.focusKey = 'name'
    main.setAttribute('aria-expanded', String(open))
    main.addEventListener('click', () => this.fold(p.id))
    const sub = el('span', { className: 'mcp-plugin-sub' })
    if (p.update !== null) sub.append(el('span', { className: 'mcp-badge mcp-badge-update', textContent: `${p.update} available` }))
    sub.append(el('span', { className: 'mcp-detail', textContent: pluginLine(p) }))
    main.append(el('span', { className: 'mcp-name', textContent: p.name }), sub)
    const actions = el('div', { className: 'mcp-actions' })
    if (p.update !== null) actions.append(control('Update', 'mcp-btn small', 'update', () => this.perform(tabId, p.id, { kind: 'update', id: p.id })))
    actions.append(this.switchControl(tabId, p))
    line.append(icon, main, actions)
    item.append(line)
    if (state.error !== null) item.append(errorBox(state.error))
    if (open) item.append(this.details(tabId, p, state))
    freeze(item, state.busy)
    return item
  }

  private switchControl(tabId: string, p: PluginView): HTMLButtonElement {
    const sw = el('button', { className: 'mcp-switch', type: 'button' })
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', String(p.enabled))
    sw.setAttribute('aria-label', p.enabled ? `Turn ${p.name} off` : `Turn ${p.name} on`)
    sw.dataset.focusKey = 'switch'
    sw.addEventListener('click', () => this.perform(tabId, p.id, { kind: p.enabled ? 'disable' : 'enable', id: p.id }))
    return sw
  }

  /** an unfolded plugin: its description, its scope, its errors, and Uninstall, which asks in the row first */
  private details(tabId: string, p: PluginView, state: ItemState): HTMLElement {
    const box = el('div', { className: 'mcp-plugin-details' })
    if (p.description !== '') box.append(el('p', { className: 'mcp-plugin-desc', textContent: p.description }))
    box.append(el('div', { className: 'mcp-plugin-scope', textContent: `Scope: ${p.scope}` }))
    for (const e of p.errors) box.append(errorBox(e))
    if (state.asking) {
      box.append(this.ask(`Uninstall ${p.name}?`, 'Uninstall', 'uninstall', () => {
        state.asking = false
        this.perform(tabId, p.id, { kind: 'uninstall', id: p.id })
      }, () => {
        state.asking = false
        this.cb.repaint()
      }))
    } else {
      box.append(control('Uninstall', 'mcp-btn mcp-red', 'uninstall', () => {
        state.asking = true
        this.cb.repaint()
      }))
    }
    return box
  }

  private fold(id: string): void {
    if (this.unfolded.has(id)) this.unfolded.delete(id)
    else this.unfolded.add(id)
    this.cb.repaint()
  }

  private discover(tabId: string, offers: PluginOffer[]): HTMLElement[] {
    const out: HTMLElement[] = []
    if (this.only !== null) {
      const chip = el('button', { className: 'mcp-filter-chip', type: 'button', textContent: `${this.only} ✕` })
      chip.addEventListener('click', () => {
        this.only = null
        this.cb.repaint()
      })
      out.push(chip)
    }
    const shown = offers.filter((o) => this.only === null || o.marketplace === this.only)
    if (shown.length === 0) return [...out, el('div', { className: 'mcp-empty', textContent: NO_DISCOVER })]
    out.push(el('div', { className: 'mcp-grid' }, ...shown.map((o) => this.card(tabId, o))))
    return out
  }

  /** a Discover card: its icon and name, its description, its marketplace and installs, and Install; its error under it */
  private card(tabId: string, o: PluginOffer): HTMLElement {
    const state = this.item(tabId, o.id)
    const card = el('div', { className: 'mcp-card' })
    card.dataset.name = o.id
    const icon = el('span', { className: 'mcp-icon mcp-icon-sm', textContent: initials(o.name) })
    icon.style.background = iconColor(o.name)
    const head = el('div', { className: 'mcp-card-head' }, icon, el('span', { className: 'mcp-card-name', textContent: o.name }))
    const meta = o.installs === null ? o.marketplace : `${o.marketplace} · ${countLabel(o.installs)}`
    const install = control('Install', 'mcp-btn primary small', 'install', () => this.install(tabId, o))
    const foot = el('div', { className: 'mcp-card-foot' }, el('span', { className: 'mcp-card-meta', textContent: meta }), install)
    card.append(head, el('p', { className: 'mcp-card-desc', textContent: o.description }), foot)
    if (state.error !== null) card.append(errorBox(state.error))
    freeze(card, state.busy)
    return card
  }

  /** an install: a plugin with required options asks for them in a form above the list, before the session restarts */
  private install(tabId: string, o: PluginOffer): void {
    const state = this.item(tabId, o.id)
    state.busy = true
    state.error = null
    this.cb.repaint()
    void this.cb.run(tabId, { kind: 'install', id: o.id }).then((result) => {
      state.busy = false
      if (!result.ok) {
        state.error = result.error
        this.cb.repaint()
        return
      }
      if (result.options !== undefined && result.options.length > 0) this.askOptions(tabId, o, result.options)
      this.cb.changed()
      this.cb.repaint()
    })
  }

  /** the settings form of an install: one input per option, a password field for a sensitive one; the values live in the inputs only */
  private askOptions(tabId: string, o: PluginOffer, options: PluginOption[]): void {
    // a form of another plugin goes first: its plugin is told it is configured later
    this.release()
    const inputs: [string, HTMLInputElement][] = []
    const error = el('div', { className: 'mcp-error' })
    error.hidden = true
    const save = el('button', { className: 'mcp-btn primary small', type: 'button', textContent: 'Save' })
    save.dataset.focusKey = 'save'
    const later = el('button', { className: 'mcp-btn ghost small', type: 'button', textContent: 'Later' })
    later.dataset.focusKey = 'later'
    const node = el('div', { className: 'mcp-options' }, el('div', { className: 'mcp-options-head', textContent: `${o.name} needs a few settings` }))
    for (const option of options) {
      const input = el('input', { className: 'mcp-option-input', type: option.sensitive ? 'password' : 'text', spellcheck: false, autocomplete: 'off' })
      inputs.push([option.key, input])
      const field = el('div', { className: 'mcp-option' }, el('label', { className: 'mcp-option-label' }, el('span', { className: 'mcp-option-title', textContent: option.title }), input))
      if (option.description !== '') field.append(el('div', { className: 'mcp-option-hint', textContent: option.description }))
      node.append(field)
    }
    node.append(error, el('div', { className: 'mcp-options-actions' }, later, save))
    const form: OptionsForm = { tabId, id: o.id, node, inputs, error, save, later, busy: false }
    save.addEventListener('click', () => this.saveOptions(form))
    later.addEventListener('click', () => {
      this.release()
      this.cb.repaint()
    })
    this.form = form
    // the panel is not showing this plugins section any more: nobody is asked for the values, so the restart is not held
    if (!this.cb.live(tabId)) this.release()
  }

  /** Save: the values go in the one configure call; the form goes on success, and its error shows under it otherwise */
  private saveOptions(form: OptionsForm): void {
    if (form.busy) return
    const values = Object.fromEntries(form.inputs.map(([key, input]) => [key, input.value]))
    form.busy = true
    form.error.hidden = true
    form.error.textContent = ''
    form.save.disabled = true
    form.later.disabled = true
    void this.cb.run(form.tabId, { kind: 'configure', id: form.id, values }).then((result) => {
      form.busy = false
      form.save.disabled = false
      form.later.disabled = false
      if (!result.ok) {
        form.error.textContent = result.error
        form.error.hidden = false
        return
      }
      if (this.form === form) this.form = null
      this.cb.changed()
      this.cb.repaint()
    })
  }

  private marketplaces(tabId: string, list: MarketplaceView[]): HTMLElement[] {
    const out: HTMLElement[] = []
    if (list.length === 0) out.push(el('div', { className: 'mcp-empty', textContent: NO_MARKETS }))
    for (const m of list) out.push(this.marketRow(tabId, m))
    out.push(this.addBox())
    return out
  }

  /** a marketplace: its name and source, Update, and Remove, which asks in the row first */
  private marketRow(tabId: string, m: MarketplaceView): HTMLElement {
    const key = `market:${m.name}`
    const state = this.item(tabId, key)
    const item = el('div', { className: 'mcp-item mcp-market' })
    item.dataset.name = m.name
    const line = el('div', { className: 'mcp-row' })
    const text = el('span', { className: 'mcp-market-text' }, el('span', { className: 'mcp-name', textContent: m.name }), el('span', { className: 'mcp-source', textContent: m.source }))
    const actions = el('div', { className: 'mcp-actions' })
    actions.append(control('Update', 'mcp-btn small', 'update', () => this.perform(tabId, key, { kind: 'marketplace-update', name: m.name })))
    actions.append(control('Remove', 'mcp-btn', 'remove', () => {
      state.asking = true
      this.cb.repaint()
    }))
    line.append(text, actions)
    item.append(line)
    if (state.asking) {
      item.append(this.ask(`Remove ${m.name}?`, 'Remove', 'remove', () => {
        state.asking = false
        this.perform(tabId, key, { kind: 'marketplace-remove', name: m.name })
      }, () => {
        state.asking = false
        this.cb.repaint()
      }))
    }
    if (state.error !== null) item.append(errorBox(state.error))
    freeze(item, state.busy)
    return item
  }

  /** the dashed box at the bottom: a click turns it into the field and Add; the add's error shows under it */
  private addBox(): HTMLElement {
    this.addButton.disabled = this.addBusy
    this.addErrorBox.textContent = this.addError
    this.addErrorBox.hidden = this.addError === ''
    const box = el('div', { className: 'mcp-market-box' })
    box.append(this.addOpen ? this.addForm : this.addOpenButton, this.addErrorBox)
    return box
  }

  private addSubmit(source: string): void {
    const tabId = this.cb.tab()
    const text = source.trim()
    if (tabId === null || text === '' || this.addBusy) return
    this.addBusy = true
    this.addError = ''
    this.cb.repaint()
    void this.cb.run(tabId, { kind: 'marketplace-add', source: text }).then((result) => {
      this.addBusy = false
      if (!result.ok) {
        this.addError = result.error
      } else {
        // the added marketplace's plugins are the Discover list; an unnamed one shows them all
        this.addOpen = false
        this.addField.value = ''
        this.sub = 'discover'
        this.only = result.marketplace ?? null
        this.cb.changed()
      }
      this.cb.repaint()
    })
  }

  /** a confirmation in the row: its text, the red button named by label (its focus key is confirm-<key>) and Cancel */
  private ask(text: string, label: string, key: string, yes: () => void, no: () => void): HTMLElement {
    const box = el('div', { className: 'mcp-confirm' })
    box.append(el('span', { className: 'mcp-confirm-text', textContent: text }), control(label, 'mcp-btn mcp-red', `confirm-${key}`, yes), control('Cancel', 'mcp-btn', 'cancel', no))
    return box
  }
}

function control(text: string, className: string, key: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { className, type: 'button', textContent: text })
  b.dataset.focusKey = key
  b.addEventListener('click', onClick)
  return b
}

function errorBox(text: string): HTMLElement {
  return el('div', { className: 'mcp-error', textContent: text })
}

/** the controls of a row or a card are off while its action runs; its name stays */
function freeze(node: HTMLElement, busy: boolean): void {
  for (const b of node.querySelectorAll<HTMLButtonElement>('button:not(.mcp-main)')) b.disabled = busy
}
