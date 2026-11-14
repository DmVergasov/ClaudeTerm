import { accountNameError, CARRY_ITEMS, CARRY_LABELS, MAIN_ACCOUNT, type AccountBegin, type AccountFlowView, type AccountView, type AccountsView, type CarryItem, type CarryLine, type CarryPreview, type FlowAction, type FlowMode, type PickedFolder } from '../shared/accounts'
import { helperTitle, primaryLabel, shortPath, tickRows, type TickRow } from './account-view'
import { el } from './dom'

const ct = window.ct

const STEP_NAMES = ['Set up', 'Sign in', 'Done']
const LINE_ICONS: Record<'done' | 'skipped' | 'failed', string> = { done: '✓', skipped: '!', failed: '×' }

/** step 1 (add, to-login, carry): what the person has typed or picked so far */
interface Form {
  mode: FlowMode
  account: AccountView | null
  accounts: AccountsView
  name: string
  email: string
  /** the account the items are carried from: an account id, or null for Main account */
  source: string | null
  preview: CarryPreview | null
  loading: boolean
  /** bumped on each source change: an answer for an older source is dropped */
  seq: number
  /** the items ticked for the carry-over */
  ticks: Set<CarryItem>
  /** a folder picked with Use a folder I already have…, kept as it is */
  folder: Extract<PickedFolder, { ok: true }> | null
  error: string | null
  busy: boolean
  ticksEl: HTMLElement | null
  primaryBtn: HTMLButtonElement | null
}

interface Dialog {
  box: HTMLElement
  scrim: HTMLElement
}

/** the helper over the Settings window: one at a time */
let dialog: Dialog | null = null
/** step 1, while the person fills it in; null once a flow runs */
let form: Form | null = null
/** the flow main runs, as it last published it */
let flow: AccountFlowView | null = null
/** the element that had the focus before the helper opened: it gets the focus back */
let returnFocus: HTMLElement | null = null
/** the home folder, which paths are shortened by */
let home = ''

void ct.appInfo().then((i) => {
  home = i.homeDir
})
// a flow main runs is followed: one begun from the main window opens the helper and shows each step; one already running shows at load
ct.onAccountFlow(onFlow)
void ct.accountFlow().then(onFlow)

/** opens the helper for a mode: the running flow when there is one, else step 1, or the sign-in at once for sign-in-again */
export function openHelper(o: { mode: FlowMode; account: AccountView | null; accounts: AccountsView }): void {
  void open(o)
}

/** true while the helper is open: the Settings page's own shortcuts leave the focus to it */
export function helperOpen(): boolean {
  return dialog !== null
}

async function open(o: { mode: FlowMode; account: AccountView | null; accounts: AccountsView }): Promise<void> {
  const running = await ct.accountFlow()
  if (running !== null) {
    onFlow(running)
    return
  }
  if (o.mode === 'sign-in-again' && o.account !== null) {
    await signInAgain(o.account)
    return
  }
  form = newForm(o)
  ensureDialog()
  draw()
}

async function signInAgain(a: AccountView): Promise<void> {
  const r = await ct.beginAccountFlow({ mode: 'sign-in-again', id: a.id, name: a.name, email: a.email, source: null, items: [], adopt: false })
  if (r.ok) {
    onFlow(await ct.accountFlow())
    return
  }
  const d = ensureDialog()
  d.box.className = 'account-dialog helper-error-box'
  d.box.replaceChildren(head(helperTitle('sign-in-again', a.name), null), body([el('span', { className: 'field-error', textContent: r.error })]), foot([button('Cancel', 'ghost', closeDialog)]))
  focusFirst(d.box)
}

/** main's flow, as published: a running one takes the helper over; none left closes it, unless step 1 is being filled in */
function onFlow(v: AccountFlowView | null): void {
  flow = v
  if (v === null) {
    if (form === null) closeDialog()
    return
  }
  form = null
  ensureDialog()
  draw()
}

function ensureDialog(): Dialog {
  if (dialog !== null) return dialog
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const box = el('div', { className: 'account-dialog' })
  box.setAttribute('role', 'dialog')
  const scrim = el('div', { className: 'account-scrim' }, box)
  document.body.append(scrim)
  document.addEventListener('keydown', onKey, true)
  dialog = { box, scrim }
  return dialog
}

/** closes the helper; a flow still running stays in main */
function closeDialog(): void {
  if (dialog === null) return
  document.removeEventListener('keydown', onKey, true)
  dialog.scrim.remove()
  dialog = null
  form = null
  const back = returnFocus
  returnFocus = null
  back?.focus()
}

/** Esc and ✕: step 1 closes; a finished flow is done; any other flow step is left running */
function dismiss(): void {
  if (form === null && flow?.step === 'done') {
    flow = null
    ct.accountFlowAction({ kind: 'close' })
  }
  closeDialog()
}

/** Esc closes the helper (and stops at it, so the Settings window stays open); Tab stays inside the box */
function onKey(e: KeyboardEvent): void {
  if (dialog === null) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    dismiss()
    return
  }
  if (e.key === 'Tab') trapTab(e, dialog.box)
}

function trapTab(e: KeyboardEvent, box: HTMLElement): void {
  const items = Array.from(box.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'))
  const first = items[0]
  const last = items[items.length - 1]
  if (first === undefined || last === undefined) return
  const active = document.activeElement
  if (!(active instanceof Node) || !box.contains(active)) {
    e.preventDefault()
    first.focus()
  } else if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

function focusFirst(box: HTMLElement): void {
  const target = box.querySelector<HTMLElement>('[data-focus]') ?? box.querySelector<HTMLElement>('button, input, select')
  target?.focus()
}

/** draws the helper's box: step 1 while a form is open, else the flow's step */
function draw(): void {
  if (dialog === null) return
  const box = dialog.box
  if (form !== null) {
    box.className = 'account-dialog helper-form'
    box.replaceChildren(...formParts(form))
    paintTicks(form)
  } else if (flow !== null) {
    box.className = `account-dialog ${flow.step === 'done' ? 'helper-done' : 'helper-flow'}`
    box.replaceChildren(...flowParts(flow))
  } else {
    return
  }
  focusFirst(box)
}

function newForm(o: { mode: FlowMode; account: AccountView | null; accounts: AccountsView }): Form {
  const f: Form = {
    mode: o.mode,
    account: o.account,
    accounts: o.accounts,
    name: o.mode === 'to-login' && o.account !== null ? o.account.name : '',
    email: '',
    source: null,
    preview: null,
    loading: false,
    seq: 0,
    ticks: new Set(),
    folder: null,
    error: null,
    busy: false,
    ticksEl: null,
    primaryBtn: null
  }
  void loadPreview(f)
  return f
}

/** counts what the source has to carry: the ticks wait for the answer; an answer for an older source is dropped */
async function loadPreview(f: Form): Promise<void> {
  const seq = ++f.seq
  f.preview = null
  f.loading = true
  f.ticks = new Set()
  paintTicks(f)
  const p = await ct.carryPreview(f.source, f.account?.id ?? null)
  if (form !== f || f.seq !== seq) return
  f.loading = false
  f.preview = p
  f.ticks = new Set(p === null ? [] : tickRows(p, tickOptions(f)).filter((r) => r.ticked).map((r) => r.item))
  paintTicks(f)
}

function tickOptions(f: Form): { adopt: boolean; mode: FlowMode; targetName: string } {
  return { adopt: f.folder !== null, mode: f.mode, targetName: f.account?.name ?? f.name.trim() }
}

function paintTicks(f: Form): void {
  const box = f.ticksEl
  if (box === null) return
  if (f.loading) {
    box.replaceChildren(el('span', { className: 'hint', textContent: 'counting…' }))
  } else if (f.preview === null) {
    box.replaceChildren()
  } else {
    box.replaceChildren(...tickRows(f.preview, tickOptions(f)).map((r) => tickBox(f, r)))
  }
}

function tickBox(f: Form, r: TickRow): HTMLElement {
  const input = el('input', { type: 'checkbox', checked: f.ticks.has(r.item) && !r.disabled, disabled: r.disabled })
  input.addEventListener('change', () => {
    if (input.checked) f.ticks.add(r.item)
    else f.ticks.delete(r.item)
  })
  return el('label', { className: r.disabled ? 'account-tick disabled' : 'account-tick' },
    input,
    el('span', { className: 'account-tick-text' }, el('b', { textContent: r.label }), el('small', { textContent: r.note })),
    el('span', { className: 'helper-count', textContent: r.count }))
}

function selectAll(f: Form, on: boolean): void {
  if (f.preview === null) return
  f.ticks = on ? new Set(tickRows(f.preview, tickOptions(f)).filter((r) => !r.disabled).map((r) => r.item)) : new Set()
  paintTicks(f)
}

/** the source's path: its email and folder, shortened */
function sourceWhere(f: Form): string {
  if (f.source === null) {
    const m = f.accounts.main
    return joined(m.email, m.folder === null ? null : shortPath(m.folder, home))
  }
  const a = f.accounts.accounts.find((x) => x.id === f.source)
  return a === undefined ? '' : joined(a.email, a.folder === null ? null : shortPath(a.folder, home))
}

function formParts(f: Form): HTMLElement[] {
  f.ticksEl = el('div', { className: 'account-ticks' })
  const bodyParts: HTMLElement[] = [...folderBlock(f)]
  if (f.mode !== 'carry') bodyParts.push(fieldsBlock(f))
  bodyParts.push(sourceBlock(f), f.ticksEl, el('div', { className: 'helper-lock', textContent: "Never carried: the sign-in of Main account, its conversations, Claude Code's caches." }))
  if (f.mode === 'to-login') bodyParts.push(info('Its tabs keep running on the token until they restart. The token is deleted once you are signed in.', false))

  f.primaryBtn = button(primaryLabel(f.mode, f.folder === null ? null : { signedIn: f.folder.signedIn }), 'primary', () => void submit(f))
  updatePrimary(f)
  const footParts: HTMLElement[] = []
  if (f.mode === 'add') footParts.push(button('Use a folder I already have…', 'helper-foot-link', () => void pickFolder(f)))
  footParts.push(button('Cancel', 'ghost', closeDialog), f.primaryBtn)
  return [
    head(helperTitle(f.mode, f.account?.name ?? ''), f.mode === 'carry' ? null : steps(0)),
    body(bodyParts),
    foot(footParts),
    ...(f.error === null ? [] : [el('div', { className: 'field-error helper-error', textContent: f.error })])
  ]
}

function fieldsBlock(f: Form): HTMLElement {
  const name = el('input', { type: 'text', spellcheck: false, className: 'text-input', value: f.name, placeholder: 'Work, Personal…' })
  name.dataset.accountField = 'name'
  name.setAttribute('data-focus', '')
  name.addEventListener('input', () => {
    f.name = name.value
    updatePrimary(f)
  })
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit(f)
  })
  const email = el('input', { type: 'text', spellcheck: false, className: 'text-input', value: f.email })
  email.addEventListener('input', () => {
    f.email = email.value
  })
  return el('div', { className: 'helper-fields' },
    el('div', { className: 'helper-col' }, el('label', { className: 'account-field' }, el('span', { textContent: 'Name' }), name)),
    el('div', { className: 'helper-col' },
      el('label', { className: 'account-field' }, el('span', { textContent: 'Email (optional)' }), email),
      el('span', { className: 'helper-note', textContent: 'Fills in the sign-in page' })))
}

function sourceBlock(f: Form): HTMLElement {
  const select = el('select', { className: 'text-input helper-source-select' })
  const choices = [
    { value: '', label: MAIN_ACCOUNT },
    ...f.accounts.accounts.filter((a) => a.kind === 'login' && a.state === 'ready' && a.id !== f.account?.id).map((a) => ({ value: a.id, label: a.name }))
  ]
  for (const c of choices) select.append(el('option', { value: c.value, textContent: c.label }))
  select.value = f.source ?? ''
  const where = el('span', { className: 'helper-path', textContent: sourceWhere(f) })
  select.addEventListener('change', () => {
    f.source = select.value === '' ? null : select.value
    where.textContent = sourceWhere(f)
    void loadPreview(f)
  })
  return el('div', { className: 'helper-source-block' },
    el('span', { className: 'helper-label', textContent: 'Carry over from' }),
    el('div', { className: 'helper-source' },
      select,
      where,
      el('span', { className: 'helper-links' },
        button('Select all', 'helper-link', () => selectAll(f, true)),
        button('None', 'helper-link', () => selectAll(f, false)))))
}

/** the folder a person picked: its path, who is signed in there, and the note that its ticks start off */
function folderBlock(f: Form): HTMLElement[] {
  const picked = f.folder
  if (picked === null) return []
  const who = picked.signedIn
    ? el('div', { className: 'helper-found' }, el('span', { className: 'helper-ok', textContent: '✓ Signed in' }), el('span', { textContent: joined(picked.email, picked.plan) }))
    : el('div', { className: 'helper-found off' }, el('span', { className: 'helper-amber', textContent: 'Not signed in' }))
  return [
    el('div', { className: 'helper-folder' },
      el('span', { className: 'helper-label', textContent: 'Folder' }),
      el('div', { className: 'helper-field' },
        el('span', { className: 'helper-mono', textContent: shortPath(picked.path, home) }),
        button('Change…', 'ghost', () => void pickFolder(f)))),
    who,
    el('span', { className: 'helper-note', textContent: 'This folder has its own setup: tick what to carry over anyway' })
  ]
}

async function pickFolder(f: Form): Promise<void> {
  const r = await ct.pickAccountFolder()
  if (form !== f || r === null) return
  if (!r.ok) {
    f.error = r.error
    draw()
    return
  }
  f.folder = r
  if (f.name.trim() === '') f.name = folderName(r.path)
  f.error = null
  f.ticks = new Set()
  draw()
}

/** a folder's name as an account's: without leading dots and claude- */
function folderName(path: string): string {
  const base = path.split(/[\\/]/).filter((p) => p !== '').pop() ?? ''
  return base.replace(/^\.+/, '').replace(/^claude-/i, '')
}

function nameValid(f: Form): boolean {
  if (f.mode === 'carry') return true
  const own = f.mode === 'to-login' ? f.account?.id : undefined
  const taken = f.accounts.accounts.filter((a) => a.id !== own).map((a) => a.name)
  return accountNameError(f.name, taken) === null
}

function updatePrimary(f: Form): void {
  if (f.primaryBtn !== null) f.primaryBtn.disabled = f.busy || !nameValid(f)
}

function beginRequest(f: Form): AccountBegin {
  const items = CARRY_ITEMS.filter((i) => f.ticks.has(i))
  if (f.mode === 'carry') return { mode: 'carry', id: f.account?.id ?? null, name: null, email: null, source: f.source, items, adopt: false }
  const email = f.email.trim()
  return {
    mode: f.mode,
    id: f.mode === 'to-login' ? (f.account?.id ?? null) : null,
    name: f.name.trim(),
    email: email === '' ? null : email,
    source: f.source,
    items,
    adopt: f.folder !== null
  }
}

/** Sign in…, Carry over, Add: main plans and starts the flow; its error stays on the form */
async function submit(f: Form): Promise<void> {
  if (f.busy || !nameValid(f)) return
  f.busy = true
  updatePrimary(f)
  const r = await ct.beginAccountFlow(beginRequest(f))
  if (form !== f) return
  f.busy = false
  if (r.ok) {
    onFlow(await ct.accountFlow())
    return
  }
  f.error = r.error
  draw()
}

function act(a: FlowAction): void {
  ct.accountFlowAction(a)
}

function flowParts(v: AccountFlowView): HTMLElement[] {
  switch (v.step) {
    case 'sign-in':
    case 'confirming':
      return signInParts(v)
    case 'failed':
      return failedParts(v)
    case 'same-login':
      return sameLoginParts(v)
    case 'done':
      return doneParts(v)
  }
}

function signInParts(v: AccountFlowView): HTMLElement[] {
  const waiting = v.step === 'confirming' ? 'Checking the sign-in…' : 'Waiting for the sign-in in your browser…'
  return [
    head(helperTitle(v.mode, v.name), steps(1)),
    body([
      el('div', { className: 'helper-wait' }, el('span', { className: 'helper-spin' }), el('span', { textContent: waiting })),
      el('div', { className: 'helper-text', textContent: `Your browser opened claude.ai. Sign in with the account for ${v.name}.` }),
      info('Signed in to claude.ai as someone else? Switch accounts on that page, or copy the link from the sign-in tab into a private window.', true)
    ]),
    foot([
      el('span', { className: 'helper-foot-note', textContent: `The sign-in runs in the tab “Sign in — ${v.name}”` }),
      button('Show the sign-in tab', '', () => act({ kind: 'show-tab' })),
      button('Cancel', 'ghost', () => act({ kind: 'cancel' }))
    ])
  ]
}

function failedParts(v: AccountFlowView): HTMLElement[] {
  let text: HTMLElement | null = null
  if (v.error === 'The sign-in did not finish') {
    text = v.lastLine !== null
      ? el('div', { className: 'helper-mono', textContent: v.lastLine })
      : el('div', { className: 'helper-text', textContent: 'The sign-in tab ended before you were signed in.' })
  } else if (v.error === 'Could not confirm the sign-in') {
    text = el('div', { className: 'helper-text', textContent: 'Claude Code did not say who is signed in. Try again, or cancel.' })
  }
  return [
    head(v.error ?? 'The sign-in did not finish', null, { text: '×', className: 'red' }),
    body(text === null ? [] : [text]),
    foot([
      button('Cancel', 'ghost', () => act({ kind: 'cancel' })),
      primary('Try again', () => act({ kind: 'retry-sign-in' }), true)
    ])
  ]
}

function sameLoginParts(v: AccountFlowView): HTMLElement[] {
  const same = v.sameAs
  return [
    head(`The same login as ${same?.account ?? ''}`, null, { text: '!', className: 'amber' }),
    body([el('div', { className: 'helper-text', textContent: same === null ? '' : `This is the same login as ${same.account} (${same.email}): tabs on ${v.name} would share its limits and connectors.` })]),
    foot([
      button('Keep it anyway', 'ghost', () => act({ kind: 'keep-login' })),
      primary('Sign in with another account', () => act({ kind: 'another-login' }), true)
    ])
  ]
}

function doneParts(v: AccountFlowView): HTMLElement[] {
  const signedAs = joined(v.who.email === null ? 'Signed in' : `Signed in as ${v.who.email}`, v.who.plan)
  return [
    head(helperTitle(v.mode, v.name), v.mode === 'carry' ? null : steps(2)),
    body([
      el('div', { className: 'helper-found' }, el('span', { className: 'helper-ok', textContent: '✓ Signed in' }), el('span', { textContent: signedAs })),
      el('div', { className: 'helper-lines' }, ...v.lines.map(lineRow))
    ]),
    foot([
      el('span', { className: 'helper-mono helper-foot-note', textContent: shortPath(v.folder, home) }),
      button('Done', '', () => act({ kind: 'close' })),
      openTabButton(v)
    ])
  ]
}

/** the tab button: drawn disabled while a carried line runs, main refuses it then too (the tab starts after the carry-over) */
function openTabButton(v: AccountFlowView): HTMLButtonElement {
  const b = primary(`Open a Claude tab on ${v.name}`, () => act({ kind: 'open-tab' }))
  b.disabled = v.lines.some((l) => l.state === 'running')
  return b
}

/** one carried item: its result at the right, a failure's Try again, and the sub-lines under it */
function lineRow(l: CarryLine): HTMLElement {
  const mark = l.state === 'running'
    ? el('span', { className: 'helper-spin' })
    : el('span', { className: `helper-ic ${l.state}`, textContent: LINE_ICONS[l.state] })
  const row = el('div', { className: 'helper-line' },
    mark,
    el('span', { textContent: CARRY_LABELS[l.item] }),
    ...(l.state === 'running' ? [] : [el('span', { className: 'helper-r', textContent: l.text })]),
    ...(l.state === 'failed' ? [button('Try again', 'helper-retry', () => act({ kind: 'retry-item', item: l.item }))] : []))
  row.dataset.state = l.state
  return el('div', {}, row, ...l.subs.map((s) => el('div', { className: 'helper-sub', textContent: s })))
}

/** the steps line: the ones before `on` are done (✓), `on` is the current one */
function steps(on: number): HTMLElement {
  const parts: HTMLElement[] = []
  STEP_NAMES.forEach((name, i) => {
    if (i > 0) parts.push(el('span', { className: 'helper-ln' }))
    const state = i < on ? 'done' : i === on ? 'on' : ''
    parts.push(el('span', { className: `helper-step ${state}` }, el('i', { textContent: i < on ? '✓' : String(i + 1) }), name))
  })
  return el('span', { className: 'helper-steps' }, ...parts)
}

function head(title: string, progress: HTMLElement | null, mark?: { text: string; className: string }): HTMLElement {
  const close = button('✕', 'ghost helper-close', dismiss)
  close.setAttribute('aria-label', 'Close')
  return el('div', { className: 'account-dialog-head helper-head' },
    ...(mark === undefined ? [] : [el('span', { className: `helper-eico ${mark.className}`, textContent: mark.text })]),
    el('span', { className: 'helper-title', textContent: title }),
    ...(progress === null ? [] : [progress]),
    close)
}

function body(parts: HTMLElement[]): HTMLElement {
  return el('div', { className: 'account-dialog-body' }, ...parts)
}

function foot(parts: HTMLElement[]): HTMLElement {
  return el('div', { className: 'account-dialog-foot' }, ...parts)
}

function info(text: string, warn: boolean): HTMLElement {
  return el('div', { className: warn ? 'account-info warn' : 'account-info' }, el('i', { textContent: warn ? '!' : 'i' }), el('span', { textContent: text }))
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: text, className })
  b.addEventListener('click', onClick)
  return b
}

function primary(text: string, onClick: () => void, focus = false): HTMLButtonElement {
  const b = button(text, 'primary', onClick)
  if (focus) b.setAttribute('data-focus', '')
  return b
}

/** the parts that are known, joined with a middle dot */
function joined(...parts: (string | null)[]): string {
  return parts.filter((p): p is string => !!p).join(' · ')
}
