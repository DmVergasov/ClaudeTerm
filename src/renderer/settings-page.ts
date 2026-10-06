import './settings.css'
import type { SettingsView } from '../shared/ipc'
import { NOTIFICATION_CASES, NOTIFICATION_CHANNELS, type SettingKey, type SettingValue } from '../shared/settings-keys'
import type { NotificationCase, NotificationChannels } from '../shared/types'
import { checkNumber, checkText, CUSTOM_THEME, profileOptions, profileValue, soundChoice, themeOptions, type Checked, type Option } from './settings-form'

const ct = window.ct

const CASE_LABELS: Record<NotificationCase, string> = {
  permission: 'Claude asks for permission',
  question: 'Claude asks a question',
  done: 'Claude finished its answer',
  bell: 'Terminal bell (BEL)'
}
const CHANNEL_LABELS: Record<keyof NotificationChannels, string> = { sound: 'Sound', flash: 'Taskbar flash', tab: 'Tab highlight' }

/** one control: shows its part of the view; its inputs are disabled while settings.json is locked */
interface Control {
  inputs: (HTMLInputElement | HTMLSelectElement | HTMLButtonElement)[]
  show(view: SettingsView): void
}

type ShowError = (message: string | null) => void

const controls: Control[] = []
let view: SettingsView

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}

const showAll = (): void => { for (const c of controls) c.show(view) }

/** saves one setting; on failure the message goes under the field and the controls go back to the saved values */
async function save(key: SettingKey, value: SettingValue, error: ShowError): Promise<boolean> {
  const r = await ct.setSetting(key, value)
  error(r.ok ? null : r.error)
  if (!r.ok) showAll()
  return r.ok
}

/** an error line under a field */
function errorLine(): { line: HTMLElement; show: ShowError } {
  const line = el('div', { className: 'field-error', hidden: true })
  return {
    line,
    show: (m) => {
      line.hidden = m === null
      line.textContent = m ?? ''
    }
  }
}

/** a labelled row with an error line under it */
function field(label: string, ...content: (Node | string)[]): { row: HTMLElement; error: ShowError } {
  const e = errorLine()
  const row = el('div', { className: 'field' }, el('span', { className: 'field-label', textContent: label }), el('div', { className: 'field-input' }, ...content), e.line)
  return { row, error: e.show }
}

const hintOf = (hint?: string): HTMLElement[] => (hint ? [el('span', { className: 'hint', textContent: hint })] : [])

function textField(label: string, key: SettingKey, type: 'text' | 'number', get: (v: SettingsView) => string | number, check: (text: string) => Checked<SettingValue>, hint?: string): HTMLElement {
  const input = el('input', { type, spellcheck: false, className: 'text-input' })
  input.dataset.key = key
  const f = field(label, input, ...hintOf(hint))
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
  controls.push({
    inputs: [input],
    show: (v) => {
      // the field being typed in keeps what is typed
      if (document.activeElement === input) return
      input.value = String(get(v))
      error(null)
    }
  })
  return f.row
}

function selectField(label: string, key: SettingKey, options: (v: SettingsView) => { options: Option[]; selected: string }, toValue: (s: string) => SettingValue | undefined, hint?: string): HTMLElement {
  const select = el('select')
  select.dataset.key = key
  const f = field(label, select, ...hintOf(hint))
  select.addEventListener('change', () => {
    const value = toValue(select.value)
    if (value !== undefined) void save(key, value, f.error)
  })
  controls.push({
    inputs: [select],
    show: (v) => {
      const o = options(v)
      select.replaceChildren(...o.options.map((x) => el('option', { value: x.value, textContent: x.label })))
      select.value = o.selected
    }
  })
  return f.row
}

function checkbox(key: SettingKey, get: (v: SettingsView) => boolean, error: ShowError, label: string): HTMLInputElement {
  const box = el('input', { type: 'checkbox', title: label })
  box.dataset.key = key
  box.setAttribute('aria-label', label)
  box.addEventListener('change', () => void save(key, box.checked, error))
  controls.push({ inputs: [box], show: (v) => { box.checked = get(v) } })
  return box
}

function checkboxField(key: SettingKey, label: string, get: (v: SettingsView) => boolean): HTMLElement {
  const e = errorLine()
  return el('div', { className: 'check-field' }, el('label', { className: 'check' }, checkbox(key, get, e.show, label), ` ${label}`), e.line)
}

function notificationTable(): HTMLElement {
  const e = errorLine()
  const head = el('tr', {}, el('th'), ...NOTIFICATION_CHANNELS.map((ch) => el('th', { textContent: CHANNEL_LABELS[ch] })))
  const rows = NOTIFICATION_CASES.map((c) =>
    el('tr', {},
      el('th', { scope: 'row', textContent: CASE_LABELS[c] }),
      ...NOTIFICATION_CHANNELS.map((ch) => el('td', {}, checkbox(`notifications.${c}.${ch}`, (v) => v.settings.notifications[c][ch], e.show, `${CASE_LABELS[c]}: ${CHANNEL_LABELS[ch]}`)))
    )
  )
  return el('div', {}, el('table', { className: 'notify' }, el('thead', {}, head), el('tbody', {}, ...rows)), e.line)
}

function soundField(): HTMLElement {
  const system = el('input', { type: 'radio', name: 'sound', value: 'system' })
  const custom = el('input', { type: 'radio', name: 'sound', value: 'custom' })
  system.dataset.key = 'notifications.sound'
  custom.dataset.key = 'notifications.sound'
  const path = el('input', { type: 'text', readOnly: true, className: 'text-input sound-path', tabIndex: -1 })
  const browse = el('button', { type: 'button', textContent: 'Browse…' })
  const play = el('button', { type: 'button', textContent: '▶ Play' })
  const f = field('Sound',
    el('div', { className: 'sound-line' }, el('label', {}, system, ' Windows default'), el('label', {}, custom, ' Custom .wav')),
    el('div', { className: 'sound-line' }, path, browse, play))
  const pick = async (): Promise<void> => {
    const file = await ct.pickSound()
    if (file) await save('notifications.sound', file, f.error)
    // cancelled: the radio buttons go back to the sound in use
    else showAll()
  }
  system.addEventListener('change', () => void save('notifications.sound', 'system', f.error))
  custom.addEventListener('change', () => void pick())
  browse.addEventListener('click', () => void pick())
  play.addEventListener('click', () => ct.playSound())
  controls.push({
    inputs: [system, custom, browse, play],
    show: (v) => {
      const s = soundChoice(v.settings.notifications.sound)
      system.checked = !s.custom
      custom.checked = s.custom
      path.value = s.path
    }
  })
  return f.row
}

function section(title: string, note: string | null, ...content: HTMLElement[]): HTMLElement {
  const h = el('h2', { className: 'section-title' }, title, ...(note ? [el('span', { className: 'section-note', textContent: note })] : []))
  return el('section', {}, h, ...content)
}

const openFile = (): HTMLButtonElement => {
  const b = el('button', { type: 'button', textContent: 'Open settings.json' })
  b.addEventListener('click', () => ct.openSettingsFile())
  return b
}

const bannerText = el('span')
const banner = el('div', { className: 'settings-banner', hidden: true }, bannerText, openFile())
const notice = el('div', { className: 'settings-notice', hidden: true })

const automaticHint = '(PowerShell 7 if installed, else Windows PowerShell)'
const root = document.getElementById('settings')!
root.append(
  el('h1', { className: 'settings-heading', textContent: 'Settings' }),
  banner,
  notice,
  section('Notifications', 'when a tab you are not looking at needs you', notificationTable(), soundField()),
  section('Appearance', null,
    textField('Font', 'font.family', 'text', (v) => v.settings.font.family, checkText),
    textField('Size', 'font.size', 'number', (v) => v.settings.font.size, (t) => checkNumber('font.size', t)),
    selectField('Theme', 'theme', (v) => themeOptions(v.settings.theme), (s) => (s === CUSTOM_THEME ? undefined : s)),
    textField('Scrollback lines', 'scrollback', 'number', (v) => v.settings.scrollback, (t) => checkNumber('scrollback', t), 'applies to new tabs')),
  section('Shells', null,
    selectField('Default shell', 'defaultProfile', (v) => profileOptions(v.profiles, v.settings.defaultProfile), profileValue, automaticHint)),
  section('Claude Code', 'applies to new tabs',
    textField('Command', 'claude.command', 'text', (v) => v.settings.claude.command, checkText),
    selectField('Shell for Claude tabs', 'claude.shellProfile', (v) => profileOptions(v.profiles, v.settings.claude.shellProfile), profileValue)),
  section('Images', 'applies to new tabs',
    checkboxField('imageWatch.enabled', 'Watch Claude tab folders for new images', (v) => v.settings.imageWatch.enabled),
    checkboxField('imagePanel.autoOpen', 'Open the image panel when a new image arrives', (v) => v.settings.imagePanel.autoOpen)),
  section('Updates', null,
    checkboxField('autoUpdate', 'Check for updates automatically', (v) => v.settings.autoUpdate)),
  el('footer', { className: 'settings-footer' }, el('span', { textContent: 'Profiles, image types, ignored folders, a custom theme and the image panel size are set in settings.json' }), openFile())
)

function render(v: SettingsView): void {
  view = v
  banner.hidden = !v.locked
  bannerText.textContent = `settings.json can't be used: ${v.problems.map((p) => p.replace(/^settings\.json: /, '')).join(' ')}`
  notice.hidden = v.locked || v.problems.length === 0
  notice.replaceChildren(...v.problems.map((p) => el('div', { textContent: p })))
  for (const c of controls) for (const i of c.inputs) i.disabled = v.locked
  showAll()
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close()
})

ct.onSettingsView(render)
void ct.getSettingsView().then(render)
