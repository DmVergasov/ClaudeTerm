import { MAIN_ACCOUNT, type AccountResult, type AccountsView, type AccountView } from '../shared/accounts'
import { validUntil } from './account-items'
import { el, section } from './dom'

const ct = window.ct

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

/** runs an account change; its error goes under the form; true when it was saved */
async function run(change: Promise<AccountResult>, show: (m: string | null) => void): Promise<boolean> {
  const r = await change
  show(r.ok ? null : r.error)
  return r.ok
}

function accountRow(a: AccountView): HTMLElement {
  const row = el('div', { className: 'account-row' })
  const err = errorLine()
  const edit = (input: HTMLInputElement, save: () => Promise<AccountResult>): void => {
    const ok = el('button', { type: 'button', textContent: 'Save' })
    const cancel = el('button', { type: 'button', textContent: 'Cancel' })
    const submit = async (): Promise<void> => {
      if (await run(save(), err.show)) info()
    }
    const back = (): void => {
      err.show(null)
      info()
    }
    ok.addEventListener('click', () => void submit())
    cancel.addEventListener('click', back)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit()
      if (e.key === 'Escape') {
        // Escape cancels the edit; it must not reach the window, which it would close
        e.stopPropagation()
        back()
      }
    })
    row.replaceChildren(el('span', { className: 'account-name' }, input), el('span', { className: 'account-actions' }, ok, cancel), err.line)
    input.focus()
  }
  const info = (): void => {
    const rename = el('button', { type: 'button', textContent: 'Rename' })
    const replace = el('button', { type: 'button', textContent: 'Replace token' })
    const del = el('button', { type: 'button', textContent: 'Delete' })
    rename.addEventListener('click', () => {
      const input = el('input', { type: 'text', spellcheck: false, className: 'text-input', value: a.name })
      edit(input, () => ct.renameAccount(a.id, input.value))
    })
    replace.addEventListener('click', () => {
      const input = tokenInput()
      edit(input, () => ct.setAccountToken(a.id, input.value))
    })
    // the first click asks, the second deletes; the button goes back after a few seconds
    let timer: ReturnType<typeof setTimeout> | undefined
    del.addEventListener('click', () => {
      if (del.textContent === 'Confirm delete') {
        clearTimeout(timer)
        void run(ct.removeAccount(a.id), err.show)
        return
      }
      del.textContent = 'Confirm delete'
      timer = setTimeout(() => { del.textContent = 'Delete' }, 4000)
    })
    const state = a.readable ? `token valid until about ${validUntil(a.addedAt)}` : 'token cannot be read — replace it'
    row.replaceChildren(
      el('span', { className: 'account-name', textContent: a.name, title: a.name }),
      el('span', { className: a.readable ? 'hint' : 'hint account-unreadable', textContent: state }),
      el('span', { className: 'account-actions' }, rename, replace, del),
      err.line
    )
  }
  info()
  return row
}

/** Settings → Accounts: the extra subscription accounts a Claude tab can run on */
export function accountsSection(): HTMLElement {
  const list = el('div', { className: 'account-list' })
  const keyring = el('div', { className: 'account-keyring', hidden: true, textContent: 'No system keyring: tokens are stored unencrypted, readable only by your user.' })
  const name = el('input', { type: 'text', spellcheck: false, className: 'text-input', placeholder: 'Name, e.g. Personal' })
  const token = tokenInput()
  name.dataset.accountField = 'name'
  token.dataset.accountField = 'token'
  const add = el('button', { type: 'button', textContent: 'Add account' })
  const getToken = el('button', { type: 'button', textContent: 'Get a token', title: 'Opens a tab running claude setup-token: sign in with the account, then paste the token it prints' })
  const err = errorLine()
  const submit = async (): Promise<void> => {
    if (!(await run(ct.addAccount(name.value, token.value), err.show))) return
    name.value = ''
    token.value = ''
  }
  add.addEventListener('click', () => void submit())
  token.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit() })
  getToken.addEventListener('click', () => ct.getToken())
  const render = (v: AccountsView): void => {
    keyring.hidden = v.keyring
    list.replaceChildren(...(v.accounts.length === 0 ? [el('div', { className: 'hint', textContent: 'No extra accounts yet.' })] : v.accounts.map(accountRow)))
  }
  ct.onAccounts(render)
  void ct.listAccounts().then(render)
  return section('Accounts', 'switch the subscription a Claude tab runs on',
    el('div', { className: 'hint account-intro', textContent: `${MAIN_ACCOUNT} is your normal Claude Code login. An extra account runs on a token from claude setup-token, valid for a year; its tabs have no claude.ai connectors and no Remote Control.` }),
    list,
    el('div', { className: 'account-add' }, name, token, add, getToken),
    err.line,
    keyring)
}
