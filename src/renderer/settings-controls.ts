import type { SettingsView } from '../shared/ipc'
import type { SettingKey, SettingValue } from '../shared/settings-keys'
import { el } from './dom'
import { icon } from './icons'
import { checkPatterns, type Checked, type Option } from './settings-form'

// The controls of the settings window: each one is a row (its text, then the control that changes a setting) and shows its part of the view.

/** one control: shows its part of the view; its inputs are disabled while settings.json is locked */
export interface Control {
  inputs: (HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement)[]
  show(view: SettingsView): void
}

export type ShowError = (message: string | null) => void

/** the text of a row: its label, and under it what the setting does */
export interface RowText { label: string; description?: string | null }

const ct = window.ct
const controls: Control[] = []
let view: SettingsView

export function addControl(c: Control): void {
  controls.push(c)
}

/** the view shown last */
export function currentView(): SettingsView {
  return view
}

/** keeps the view, disables every listed input while settings.json is locked, and shows it */
export function applyView(v: SettingsView): void {
  view = v
  for (const c of controls) for (const i of c.inputs) i.disabled = v.locked
  showAll()
}

export function showAll(): void {
  for (const c of controls) c.show(view)
}

/** saves one setting; on failure the message goes under the field and the controls go back to the saved values */
export async function save(key: SettingKey, value: SettingValue, error: ShowError): Promise<boolean> {
  const r = await ct.setSetting(key, value)
  // put the controls back first: a text field left with Tab clears its message when it is shown again
  if (!r.ok) showAll()
  error(r.ok ? null : r.error)
  return r.ok
}

/** an error line under a field */
export function errorLine(): { line: HTMLElement; show: ShowError } {
  const line = el('div', { className: 'field-error', hidden: true })
  return {
    line,
    show: (m) => {
      line.hidden = m === null
      line.textContent = m ?? ''
    }
  }
}

/** the id of the control of a setting: the label of its row points at it */
export const controlId = (key: string): string => `setting-${key.replace(/\./g, '-')}`

/** a row: the text on the left, the control on the right (under the text when wide), and an error line; the search reads its label, description and keys */
export function row(text: RowText, keys: readonly string[], control: HTMLElement, forId: string | null, wide = false): { row: HTMLElement; error: ShowError } {
  const e = errorLine()
  const label = el('label', { className: 'rl', textContent: text.label, ...(forId === null ? {} : { htmlFor: forId }) })
  const description = text.description ? [el('div', { className: 'rd', textContent: text.description })] : []
  const r = el('div', { className: 'row search-unit' }, el('div', { className: 'row-text' }, label, ...description), el('div', { className: 'row-control' }, control), e.line)
  if (wide) r.classList.add('wide')
  r.dataset.search = `${text.label} ${text.description ?? ''} ${keys.join(' ')}`
  return { row: r, error: e.show }
}

/** a row with a text field that is saved when it is left or Enter is pressed */
export function textRow(text: RowText, key: SettingKey, get: (v: SettingsView) => string, check: (t: string) => Checked<SettingValue>, mono = false): HTMLElement {
  const input = el('input', { type: 'text', spellcheck: false, className: mono ? 'text-input mono' : 'text-input', id: controlId(key) })
  input.dataset.key = key
  const f = row(text, [key], input, controlId(key))
  const error: ShowError = (m) => {
    f.error(m)
    input.classList.toggle('invalid', m !== null)
  }
  // change fires on Enter and when the field loses focus
  input.addEventListener('change', () => {
    const c = check(input.value)
    if (c.ok) void save(key, c.value, error)
    else error(c.error)
  })
  addControl({
    inputs: [input],
    show: (v) => {
      // the field being typed in keeps what is typed
      if (document.activeElement === input) return
      input.value = get(v)
      error(null)
    }
  })
  return f.row
}

/** a row with a number field; a suffix unit goes after it, off(v) dims the row and disables the field, and step puts a Smaller and a Larger button either side of the field */
export function numberRow(text: RowText, key: SettingKey, get: (v: SettingsView) => number, check: (t: string) => Checked<SettingValue>, opts: { suffix?: string; off?: (v: SettingsView) => boolean; step?: { min: number; max: number } } = {}): HTMLElement {
  const input = el('input', { type: 'number', spellcheck: false, className: 'text-input', id: controlId(key) })
  input.dataset.key = key
  const field = opts.suffix ? el('span', { className: 'number-field' }, input, el('span', { className: 'rd unit-suffix', textContent: opts.suffix })) : input
  const smaller = el('button', { type: 'button', className: 'step', textContent: '\u2212' })
  const larger = el('button', { type: 'button', className: 'step', textContent: '+' })
  smaller.setAttribute('aria-label', 'Smaller')
  larger.setAttribute('aria-label', 'Larger')
  const control = opts.step ? el('div', { className: 'stepper' }, smaller, field, larger) : field
  const f = row(text, [key], control, controlId(key))
  const error: ShowError = (m) => {
    f.error(m)
    input.classList.toggle('invalid', m !== null)
  }
  input.addEventListener('change', () => {
    const c = check(input.value)
    if (c.ok) void save(key, c.value, error)
    else error(c.error)
  })
  // a stepper button saves the value one step on, kept within the limits
  if (opts.step) {
    const { min, max } = opts.step
    const nudge = (by: number): void => void save(key, Math.min(max, Math.max(min, get(currentView()) + by)), error)
    smaller.addEventListener('click', () => nudge(-1))
    larger.addEventListener('click', () => nudge(1))
  }
  addControl({
    inputs: opts.step ? [input, smaller, larger] : [input],
    show: (v) => {
      const off = opts.off?.(v) ?? false
      f.row.classList.toggle('off', off)
      input.disabled = v.locked || off
      if (opts.step) {
        smaller.disabled = v.locked || off || get(v) <= opts.step.min
        larger.disabled = v.locked || off || get(v) >= opts.step.max
      }
      // the field being typed in keeps what is typed
      if (document.activeElement === input) return
      input.value = String(get(v))
      error(null)
    }
  })
  return f.row
}

/** a row with a select that is saved when a choice is made */
export function selectRow(text: RowText, key: SettingKey, options: (v: SettingsView) => { options: Option[]; selected: string }, toValue: (s: string) => SettingValue | undefined): HTMLElement {
  const select = el('select', { id: controlId(key) })
  select.dataset.key = key
  const f = row(text, [key], select, controlId(key))
  select.addEventListener('change', () => {
    const value = toValue(select.value)
    if (value !== undefined) void save(key, value, f.error)
  })
  addControl({
    inputs: [select],
    show: (v) => {
      const o = options(v)
      select.replaceChildren(...o.options.map((x) => el('option', { value: x.value, textContent: x.label })))
      select.value = o.selected
    }
  })
  return f.row
}

/** a row with a switch for an on/off setting; its label switches it too */
export function switchRow(text: RowText, key: SettingKey, get: (v: SettingsView) => boolean): HTMLElement {
  const box = el('input', { type: 'checkbox', className: 'switch', id: controlId(key) })
  box.setAttribute('role', 'switch')
  box.dataset.key = key
  const f = row(text, [key], box, controlId(key))
  box.addEventListener('change', () => void save(key, box.checked, f.error))
  addControl({ inputs: [box], show: (v) => { box.checked = get(v) } })
  return f.row
}

/** a row with a list, one entry per line, under its text; saved when the field loses focus, and Restore defaults puts the default list back */
export function listRow(text: RowText, key: SettingKey, get: (v: SettingsView) => string[], defaults: readonly string[]): HTMLElement {
  const area = el('textarea', { spellcheck: false, className: 'text-input list-input', rows: 8, wrap: 'off', id: controlId(key) })
  area.dataset.key = key
  const restore = el('button', { type: 'button', textContent: 'Restore defaults' })
  restore.dataset.restore = key
  const f = row(text, [key], el('div', { className: 'list-line' }, area, restore), controlId(key), true)
  const error: ShowError = (m) => {
    f.error(m)
    area.classList.toggle('invalid', m !== null)
  }
  area.addEventListener('change', () => {
    const c = checkPatterns(area.value)
    if (c.ok) void save(key, c.value, error)
    else error(c.error)
  })
  restore.addEventListener('click', () => void save(key, [...defaults], error))
  addControl({
    inputs: [area, restore],
    show: (v) => {
      // the field being typed in keeps what is typed
      if (document.activeElement === area) return
      area.value = get(v).join('\n')
      error(null)
    }
  })
  return f.row
}

/** a checkbox of a table (the notifications), saved when it changes */
export function checkbox(key: SettingKey, get: (v: SettingsView) => boolean, error: ShowError, label: string): HTMLInputElement {
  const box = el('input', { type: 'checkbox', title: label })
  box.dataset.key = key
  box.setAttribute('aria-label', label)
  box.addEventListener('change', () => void save(key, box.checked, error))
  addControl({ inputs: [box], show: (v) => { box.checked = get(v) } })
  return box
}

/** one card of a choice section: the value a click saves, its title and note, and the parts that follow the view */
export interface CardChoice { value: string; title: string; note: string | null; chip?: string; art?: HTMLElement; selectable?: boolean; noteClass?: string }

/** a card on the page: its button, and the text and picture it shows */
interface Card { button: HTMLButtonElement; title: HTMLElement; note: HTMLElement; text: HTMLElement; chip?: HTMLElement; art?: HTMLElement }

function setChip(card: Card, chip: string | undefined): void {
  if (chip === undefined) {
    card.chip?.remove()
    card.chip = undefined
    return
  }
  if (!card.chip) {
    card.chip = el('span', { className: 'chip' })
    card.text.append(card.chip)
  }
  card.chip.textContent = chip
}

function setArt(card: Card, art: HTMLElement | undefined): void {
  if (card.art === art) return
  if (card.art && art) card.art.replaceWith(art)
  else if (art) card.button.prepend(art)
  else card.art?.remove()
  card.art = art
}

/** a section of choice cards in a radio group, one card per choice; the card of the value in use is chosen, and a click on a card calls pick with its value. The cards are rebuilt only when the choices change, so the card clicked keeps the focus */
export function cardSection(o: {
  title: string; key: SettingKey; small?: boolean; searchText: string
  choices: (v: SettingsView) => CardChoice[]; selected: (v: SettingsView) => string
  pick: (value: string, error: ShowError) => void; after?: HTMLElement
}): HTMLElement {
  const heading = el('h2', { className: 'section-title', id: `h-${controlId(o.key)}`, textContent: o.title })
  const group = el('div', { className: o.small ? 'cards cards-small' : 'cards' })
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-labelledby', heading.id)
  const e = errorLine()
  let cards: Card[] = []
  let built = ''

  const build = (choices: CardChoice[]): void => {
    cards = choices.map((c) => {
      // the name has an element of its own: the search splits its text into marks, and a later title replaces them all
      const title = el('span', { className: 'ct-name', textContent: c.title })
      const note = el('span', { className: 'cd' })
      const check = el('span', { className: 'card-check' })
      check.innerHTML = icon('check', 16)
      const text = el('span', { className: 'card-text' }, el('span', { className: 'ct' }, title, check), note)
      const button = el('button', { type: 'button', className: 'card' }, text)
      button.setAttribute('role', 'radio')
      button.dataset.key = o.key
      button.dataset.value = c.value
      button.addEventListener('click', () => o.pick(c.value, e.show))
      return { button, title, note, text }
    })
    group.replaceChildren(...cards.map((card) => card.button))
    built = choices.map((c) => c.value).join('\n')
  }

  const sec = el('section', { className: 'settings-section cards-section search-unit' }, heading, group, e.line, ...(o.after ? [o.after] : []))
  sec.dataset.search = `${o.title} ${o.searchText} ${o.key}`

  addControl({
    inputs: [],
    show: (v) => {
      const choices = o.choices(v)
      if (choices.map((c) => c.value).join('\n') !== built) build(choices)
      const selected = o.selected(v)
      choices.forEach((c, i) => {
        const card = cards[i]
        // set only when it changes, so the search's marks stay on a name that did not
        if (card.title.textContent !== c.title) card.title.textContent = c.title
        card.note.className = c.noteClass ? `cd ${c.noteClass}` : 'cd'
        card.note.textContent = c.note ?? ''
        card.note.hidden = c.note === null
        setChip(card, c.chip)
        setArt(card, c.art)
        card.button.setAttribute('aria-checked', String(c.value === selected))
        card.button.disabled = v.locked || c.selectable === false
      })
      // the search finds the section by the cards as they show now: a title or note can change with the view
      sec.dataset.search = [o.title, o.searchText, o.key, ...choices.map((c) => `${c.title} ${c.note ?? ''}`)].join(' ')
    }
  })
  return sec
}
