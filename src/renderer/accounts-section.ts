import { MAIN_ACCOUNT, type AccountResult, type AccountsView, type AccountView, type FlowMode, type MainAccountView } from '../shared/accounts'
import { openHelper } from './account-helper'
import { avatarColor, initials, mainLine, rowLine, shortPath, type RowLine } from './account-view'
import { el, section } from './dom'

const ct = window.ct

/** the home folder, which shortPath shortens paths by; empty until the app has said where it is */
let home = ''
/** the last view, drawn again once the home folder is known */
let last: AccountsView | null = null
/** the ··· menu that is open: its close, which also takes away its listeners */
let closeMenu: (() => void) | null = null

/** opens the helper over Settings for a mode and an account, with the accounts as they are now */
async function openFor(mode: FlowMode, account: AccountView | null): Promise<void> {
  openHelper({ mode, account, accounts: last ?? (await ct.listAccounts()) })
}

/** an error line under a form */
function errorLine(): { line: HTMLElement; show(m: string | null): void } {
  const line = el('div', { className: 'field-error', hidden: true })
  return {
    line,
    show: (m) => {
      line.hidden = m === null
      line.textContent = m ?? ''
    }
  }
}

/** a token is pasted, never shown */
const tokenInput = (): HTMLInputElement => el('input', { type: 'password', spellcheck: false, autocomplete: 'off', className: 'text-input', placeholder: 'Token from claude setup-token' })

/** a name, as a field of a row or a dialog */
const nameField = (name: string): HTMLInputElement => el('input', { type: 'text', spellcheck: false, className: 'text-input', value: name })

/** runs an account change; its error goes under the form; true when it was saved */
async function run(change: Promise<AccountResult>, show: (m: string | null) => void): Promise<boolean> {
  const r = await change
  show(r.ok ? null : r.error)
  return r.ok
}

/** a button: its text, its class, and what a click does; `action` names it for the windows that wire it */
function button(text: string, className: string, onClick: () => void, action?: string): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: text, className })
  b.addEventListener('click', onClick)
  if (action) b.dataset.action = action
  return b
}

/** one item of a ··· menu: a click closes the menu, then does its job */
function menuItem(label: string, close: () => void, onClick: () => void, className = ''): HTMLButtonElement {
  return button(label, className, () => {
    close()
    onClick()
  })
}

/** the parts that are known, joined with a middle dot */
function joined(...parts: (string | null)[]): string {
  return parts.filter((p): p is string => !!p).join(' · ')
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/** an avatar: the initials of the name on its colour */
function avatar(name: string, index: number, account: AccountView | null): HTMLElement {
  const c = avatarColor(account, index)
  const e = el('span', { className: 'account-avatar', textContent: initials(name) })
  e.style.background = c.background
  e.style.color = c.color
  return e
}

/** a row's line under its name: a tone icon, then the text */
function statusLine(line: RowLine): HTMLElement {
  const icon = line.tone === 'ok' ? '●' : line.tone === 'warn' ? '▲' : ''
  return el('span', { className: 'account-line' },
    ...(icon ? [el('span', { className: `account-tone ${line.tone}`, textContent: icon })] : []),
    el('span', { className: 'account-line-text', textContent: line.text }))
}

/**
 * A ··· button and its menu. `items` gets the menu's close and returns its entries. Esc and a click outside close the menu
 * (Esc does not reach the window, which it would close); one menu is open at a time.
 */
function moreMenu(name: string, items: (close: () => void) => HTMLElement[]): HTMLElement {
  const wrap = el('span', { className: 'account-more' })
  const menu = el('div', { className: 'account-menu', hidden: true })
  menu.setAttribute('role', 'menu')
  const toggle = el('button', { type: 'button', className: 'account-more-button', textContent: '···' })
  toggle.setAttribute('aria-label', `More for ${name}`)
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    e.preventDefault()
    close()
  }
  const onPointer = (e: PointerEvent): void => {
    if (!wrap.contains(e.target as Node)) close()
  }
  function close(): void {
    menu.hidden = true
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onPointer, true)
    if (closeMenu === close) closeMenu = null
  }
  const open = (): void => {
    closeMenu?.()
    menu.hidden = false
    closeMenu = close
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointer, true)
  }
  toggle.addEventListener('click', () => (menu.hidden ? open() : close()))
  menu.append(...items(close))
  wrap.append(toggle, menu)
  return wrap
}

/**
 * A dialog over the window: its scrim holds the box, and Esc closes it (and only it). `body` and `foot` are its
 * content; the caller changes them through the returned elements, and `close` takes the dialog away.
 */
function dialog(title: string, body: HTMLElement[], foot: HTMLElement[]): { body: HTMLElement; foot: HTMLElement; close(): void } {
  const bodyEl = el('div', { className: 'account-dialog-body' }, ...body)
  const footEl = el('div', { className: 'account-dialog-foot' }, ...foot)
  const box = el('div', { className: 'account-dialog' }, el('div', { className: 'account-dialog-head', textContent: title }), bodyEl, footEl)
  box.setAttribute('role', 'dialog')
  const scrim = el('div', { className: 'account-scrim' }, box)
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    e.preventDefault()
    close()
  }
  function close(): void {
    document.removeEventListener('keydown', onKey, true)
    scrim.remove()
  }
  document.addEventListener('keydown', onKey, true)
  document.body.append(scrim)
  return { body: bodyEl, foot: footEl, close }
}

/** a labelled field of a dialog */
function field(label: string, input: HTMLElement): HTMLElement {
  return el('label', { className: 'account-field' }, el('span', { textContent: label }), input)
}

/** Add with a token…: a name and a token in a dialog; the token is never shown, and the error goes under the fields */
function addWithToken(): void {
  const name = el('input', { type: 'text', spellcheck: false, className: 'text-input', placeholder: 'Name, e.g. Personal' })
  const token = tokenInput()
  name.dataset.accountField = 'name'
  token.dataset.accountField = 'token'
  const err = errorLine()
  const getToken = button('Get a token', 'ghost account-get-token', () => ct.getToken())
  getToken.title = 'Opens a tab running claude setup-token: sign in with the account, then paste the token it prints'
  const d = dialog('Add with a token', [field('Name', name), field('Token', token), err.line], [
    getToken,
    button('Cancel', 'ghost', () => d.close()),
    button('Add', 'primary', () => void submit())
  ])
  const submit = async (): Promise<void> => {
    if (await run(ct.addAccount(name.value, token.value), err.show)) d.close()
  }
  token.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit()
  })
  name.focus()
}

/**
 * Remove…: what goes with the account. A folder ClaudeTerm made is signed out and moved to the trash, ticked; its box is
 * off while tabs run on the account. A folder the user already had is only signed out of, and unticked. Tabs running on the account switch the box off for either kind.
 */
async function removeDialog(a: AccountView, home: string): Promise<void> {
  const info = await ct.accountRemoveInfo(a.id)
  if (info === null) return
  const tabs = info.tabs
  const blocked = tabs > 0
  const check = el('input', { type: 'checkbox', checked: info.created && !blocked, disabled: blocked })
  const path = info.folder === null ? null : shortPath(info.folder, home)
  const note = info.created
    ? joined(path, `${info.conversations} ${plural(info.conversations, 'conversation', 'conversations')}`, 'they leave Recent sessions')
    : joined(path)
  const tick = el('label', { className: blocked ? 'account-tick disabled' : 'account-tick' },
    check,
    el('span', { className: 'account-tick-text' },
      el('b', { textContent: info.created ? 'Sign out and move its folder to the trash' : 'Sign out of it' }),
      el('small', { textContent: note })))
  const err = errorLine()
  const body: HTMLElement[] = [el('p', { className: 'account-dialog-text', textContent: `Tabs on ${a.name} keep running until they close; then they start on Main account.` }), tick]
  if (blocked) {
    body.push(el('div', { className: 'account-info warn' },
      el('i', { textContent: '!' }),
      el('span', { textContent: `Close the ${tabs} ${plural(tabs, 'tab', 'tabs')} on ${a.name} to remove its folder too` })))
  }
  body.push(err.line)
  const confirm = async (): Promise<void> => {
    const r = await ct.removeAccount(a.id, { signOut: check.checked, deleteFolder: check.checked && info.created })
    if (!r.ok) {
      err.show(r.error)
      return
    }
    if (r.problems.length === 0) {
      d.close()
      return
    }
    // the account is gone already; what could not be done is said here
    d.body.append(...r.problems.map((p) => el('div', { className: 'field-error', textContent: p })))
    d.foot.replaceChildren(button('Close', 'ghost', () => d.close()))
  }
  const d = dialog(`Remove ${a.name}?`, body, [
    button('Cancel', 'ghost', () => d.close()),
    button('Remove', 'danger', () => void confirm())
  ])
}

/** Main account's row: who is signed in there, its folder, and the login its tabs run on when they are not on an account */
function mainRow(m: MainAccountView): HTMLElement {
  const title = el('span', { className: 'account-title' },
    el('span', { className: 'account-name', textContent: MAIN_ACCOUNT }),
    el('span', { className: 'account-badge', textContent: 'Your Claude Code login' }))
  const actions = m.folder === null ? [] : [button('Show folder', 'ghost', () => ct.showAccountFolder(null))]
  return el('div', { className: 'account-row account-main' },
    avatar(MAIN_ACCOUNT, 0, null),
    el('span', { className: 'account-text' }, title, statusLine({ tone: 'ok', text: mainLine(m, home) })),
    el('span', { className: 'account-actions' }, ...actions))
}

/** an extra account's row: its state with the one fix that state needs; ··· holds the rest */
function accountRow(a: AccountView, index: number): HTMLElement {
  const row = el('div', { className: 'account-row' })
  row.dataset.account = a.id
  const err = errorLine()
  const title = el('span', { className: 'account-title' }, el('span', { className: 'account-name', textContent: a.name, title: a.name }))
  if (a.kind === 'token') title.append(el('span', { className: 'account-badge', textContent: 'Token' }))
  const status = statusLine(rowLine(a, home))
  status.querySelector('.account-line-text')?.classList.toggle('account-unreadable', a.kind === 'token' && !a.readable)
  const text = (): HTMLElement => el('span', { className: 'account-text' }, title, status)

  /** the row's content is the input, Save and Cancel; the row comes back as it was */
  const edit = (input: HTMLInputElement, save: () => Promise<AccountResult>): void => {
    const submit = async (): Promise<void> => {
      if (await run(save(), err.show)) info()
    }
    const back = (): void => {
      err.show(null)
      info()
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit()
      if (e.key === 'Escape') {
        // Escape cancels the edit; it must not reach the window, which it would close
        e.stopPropagation()
        back()
      }
    })
    row.replaceChildren(
      avatar(a.name, index, a),
      el('span', { className: 'account-edit' }, input, err.line),
      el('span', { className: 'account-actions' }, button('Save', 'primary', () => void submit()), button('Cancel', '', back)))
    input.focus()
  }
  const rename = (close: () => void): HTMLButtonElement => menuItem('Rename', close, () => {
    const input = nameField(a.name)
    edit(input, () => ct.renameAccount(a.id, input.value))
  })
  const replaceToken = (): void => {
    const input = tokenInput()
    edit(input, () => ct.setAccountToken(a.id, input.value))
  }
  const signIn = (): void => void openFor('sign-in-again', a)

  /** a token's Delete: the first click asks, the second deletes; the item goes back after a few seconds and the menu stays open */
  const deleteItem = (): HTMLButtonElement => {
    let armed: ReturnType<typeof setTimeout> | undefined
    const item = el('button', { type: 'button', textContent: 'Delete', className: 'red' })
    item.addEventListener('click', () => {
      if (item.textContent !== 'Confirm delete') {
        item.textContent = 'Confirm delete'
        armed = setTimeout(() => { item.textContent = 'Delete' }, 4000)
        return
      }
      clearTimeout(armed)
      void run(ct.removeAccount(a.id), err.show)
    })
    return item
  }

  /** a sign-in account's ···: Rename, Sign in again, Show folder, and Remove… */
  const signInMenu = (): HTMLElement => moreMenu(a.name, (close) => [
    rename(close),
    menuItem('Sign in again', close, signIn),
    ...(a.folder === null ? [] : [menuItem('Show folder', close, () => ct.showAccountFolder(a.id))]),
    el('hr'),
    menuItem('Remove…', close, () => void removeDialog(a, home), 'red')
  ])

  const info = (): void => {
    let actions: HTMLElement[]
    if (a.kind === 'token') {
      actions = [
        button('Sign in instead…', '', () => void openFor('to-login', a), 'sign-in-instead'),
        button('Replace token', '', replaceToken),
        moreMenu(a.name, (close) => [rename(close), deleteItem()])
      ]
    } else if (a.state === 'signed-out') {
      actions = [button('Sign in again', 'warn', signIn, 'sign-in-again'), signInMenu()]
    } else if (a.state === 'missing') {
      actions = [button('Remove', '', () => void removeDialog(a, home), 'remove')]
    } else {
      actions = [button('New tab', '', () => ct.openAccountTab(a.id)), button('Carry over…', '', () => void openFor('carry', a), 'carry'), signInMenu()]
    }
    row.replaceChildren(avatar(a.name, index, a), text(), el('span', { className: 'account-actions' }, ...actions), err.line)
  }

  info()
  return row
}

/** Settings → Accounts: Main account and the extra accounts, the Claude logins a Claude tab can run on */
export function accountsSection(): HTMLElement {
  const card = el('div', { className: 'account-list' })
  const keyring = el('div', { className: 'account-keyring', hidden: true, textContent: 'No system keyring: tokens are stored unencrypted, readable only by your user.' })
  const render = (v: AccountsView): void => {
    last = v
    keyring.hidden = v.keyring || !v.accounts.some((a) => a.kind === 'token')
    card.replaceChildren(mainRow(v.main), ...v.accounts.map((a, i) => accountRow(a, i)))
  }
  const addRow = el('div', { className: 'account-add' },
    button('＋ Add account…', 'primary', () => void openFor('add', null), 'add'),
    button('Add with a token…', '', addWithToken),
    el('span', { className: 'hint', textContent: "A token makes model requests only, and shares Main account's setup and history" }))
  const sec = section('Accounts', 'the Claude logins your tabs run on',
    el('p', { className: 'hint account-intro', textContent: 'Each account signs in for itself and keeps its own settings and plugins, so its tabs get claude.ai connectors and Remote Control. The conversations of every account are in one Recent sessions list.' }),
    card,
    addRow,
    keyring)
  // the page asks for a check of the accounts each time it is shown; main answers at most once a minute
  let shown = false
  new MutationObserver(() => {
    const page = sec.closest<HTMLElement>('.settings-page')
    const now = page !== null && !page.hidden
    if (now && !shown) ct.checkAccounts()
    shown = now
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] })
  ct.onAccounts(render)
  void ct.listAccounts().then(render)
  void ct.appInfo().then((i) => {
    home = i.homeDir
    if (last !== null) render(last)
  })
  return sec
}
