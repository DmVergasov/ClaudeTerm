import type { BrowserProfileAction, BrowserProfilesView, BrowserProfileView, ImportSourceView, ImportStatus } from '../shared/browser'
import { importView } from '../shared/browser-import-text'
import { dialog } from './accounts-section'
import { el, section } from './dom'

const ct = window.ct

/** a button: its text, its class, and what a click does */
function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: text, className })
  b.addEventListener('click', onClick)
  return b
}

/** the change goes to main, which answers with the list (a refused change answers the list as it was) */
function act(a: BrowserProfileAction, render: (v: BrowserProfilesView) => void): void {
  void ct.browserProfileAction(a).then(render)
}

/** one profile's row: its name (renamed in place), its default, its always-allowed sites and its actions */
function profileRow(p: BrowserProfileView, defaultId: string, render: (v: BrowserProfilesView) => void): HTMLElement {
  const row = el('div', { className: 'browser-profile-row' })
  row.dataset.profileId = p.id

  // the name is renamed in place: Enter or leaving the field saves it, Escape puts the name back
  const name = el('input', { type: 'text', spellcheck: false, className: 'text-input browser-profile-name', value: p.name })
  name.setAttribute('aria-label', 'Profile name')
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') name.blur()
    if (e.key === 'Escape') {
      // Escape restores the name; it must not reach the window, which it would close
      e.stopPropagation()
      name.value = p.name
      name.blur()
    }
  })
  name.addEventListener('blur', () => {
    if (name.value !== p.name) act({ type: 'rename', id: p.id, name: name.value }, render)
  })

  const radio = el('input', { type: 'radio', name: 'browser-default', checked: p.id === defaultId })
  radio.addEventListener('change', () => act({ type: 'setDefault', id: p.id }, render))
  const isDefault = el('label', { className: 'browser-default' }, radio, el('span', { textContent: 'Default' }))

  // the switch allows every web site in this profile: while it is on, the always-allowed list below is dimmed (still editable)
  const allowAll = el('input', { type: 'checkbox', className: 'switch', checked: p.allowAll })
  allowAll.setAttribute('role', 'switch')
  allowAll.addEventListener('change', () => act({ type: 'allowAll', id: p.id, on: allowAll.checked }, render))
  const allowAllRow = el('label', { className: 'browser-allow-all' }, allowAll, el('span', { textContent: 'Always allow all sites' }))
  const allowAllHint = el('p', { className: 'browser-allow-all-hint', textContent: 'Claude opens any website in this profile without asking, signed in with its cookies.' })

  const allowed = el('div', { className: 'browser-allowed' })
  if (p.allowed.length === 0) allowed.append(el('span', { className: 'rd', textContent: 'None' }))
  for (const site of p.allowed) {
    const remove = button('×', 'browser-site-remove', () => act({ type: 'disallow', id: p.id, site }, render))
    remove.setAttribute('aria-label', `Remove ${site}`)
    allowed.append(el('span', { className: 'browser-site' }, el('span', { textContent: site }), remove))
  }

  // Clear data…: a confirm in the window's own style; the cookies, storage and cache of the profile go
  const clear = button('Clear data…', '', () => {
    const d = dialog('Clear data', [el('p', { className: 'account-dialog-text', textContent: `Clear the cookies, storage and cache of ${p.name}? Sign-ins in it are lost.` })], [
      button('Cancel', 'ghost', () => d.close()),
      button('Clear', 'danger', () => {
        d.close()
        act({ type: 'clearData', id: p.id }, render)
      })
    ])
  })
  const importCookies = button('Import cookies…', '', () => importSheet(p))
  const actions = el('div', { className: 'browser-profile-actions' }, importCookies, clear)

  // Delete: not for Default, which always exists; a confirm names what goes
  if (p.id !== 'default') {
    actions.append(button('Delete', '', () => {
      const d = dialog('Delete profile', [el('p', { className: 'account-dialog-text', textContent: `Delete the profile ${p.name}? Its tabs move to Default and its data is deleted.` })], [
        button('Cancel', 'ghost', () => d.close()),
        button('Delete', 'danger', () => {
          d.close()
          act({ type: 'remove', id: p.id }, render)
        })
      ])
    }))
  }

  const sites = el('div', { className: 'browser-profile-sites' }, el('span', { className: 'rd', textContent: 'Always allowed sites' }), allowed)
  sites.classList.toggle('is-dim', p.allowAll)

  row.append(
    el('div', { className: 'browser-profile-head' }, name, isDefault),
    allowAllRow,
    allowAllHint,
    sites,
    actions
  )
  return row
}

/**
 * The cookie import sheet of one profile: From lists the browsers (an unavailable one is listed disabled), Import starts the
 * import, and the status main reports is shown as it comes. Cancel stops the import; closing the sheet cancels a running one.
 */
// the Settings window has at most one import sheet: the one open now, for which profile, whether an import runs in it
let openSheet: { profileId: string; running(): boolean; close(): void } | null = null

function importSheet(profile: BrowserProfileView): void {
  // one sheet at a time: a sheet for the same profile stays, and so does one with an import running; any other gives way
  if (openSheet) {
    if (openSheet.profileId === profile.id || openSheet.running()) return
    openSheet.close()
  }
  let sources: ImportSourceView[] = []
  let running = false

  const from = el('select', { className: 'text-input browser-import-from' })
  const fromRow = el('label', { className: 'account-field' }, el('span', { textContent: 'From:' }), from)
  const status = el('div', { className: 'browser-import-status' })
  status.setAttribute('role', 'status')
  const choices = el('div', { className: 'browser-import-choices' })
  const importBtn = button('Import', 'primary', start)
  const closeBtn = button('Close', 'ghost', close)
  const box = el(
    'div',
    { className: 'account-dialog' },
    el('div', { className: 'account-dialog-head', textContent: `Import cookies into "${profile.name}"` }),
    el('div', { className: 'account-dialog-body' }, fromRow, status, choices),
    el('div', { className: 'account-dialog-foot' }, closeBtn, importBtn)
  )
  box.setAttribute('role', 'dialog')
  const scrim = el('div', { className: 'account-scrim' }, box)

  const picked = (): ImportSourceView | undefined => sources.find((s) => s.id === from.value)
  // From and Import are off while an import runs or the browser is asked something; Import also needs a browser that can be read
  function controls(): void {
    from.disabled = running
    importBtn.disabled = running || !picked()?.available
  }

  function show(s: ImportStatus): void {
    const v = importView(s)
    running = v.running
    const parts: HTMLElement[] = v.lines.map((line) => el('p', { textContent: line }))
    if (v.busy) parts.unshift(el('span', { className: 'helper-spin' }))
    if (v.cancel) parts.push(button('Cancel', 'ghost', () => ct.browserImportCancel()))
    status.replaceChildren(...parts)
    choices.replaceChildren(...v.choices.map((c) => button(c.label, 'browser-import-choice', () => ct.browserImportPick(c.contextId))))
    controls()
  }

  function loadSources(): void {
    void ct.browserImportSources().then((list) => {
      sources = list
      if (list.length === 0) {
        // no browser to read from: the sheet says so, and offers no Import
        fromRow.remove()
        importBtn.remove()
        status.replaceChildren(el('p', { textContent: 'No browsers found.' }))
        return
      }
      from.replaceChildren(...list.map((s) => el('option', { value: s.id, textContent: s.label, disabled: !s.available })))
      const first = list.find((s) => s.available)
      if (first) from.value = first.id
      controls()
    })
  }

  function start(): void {
    const source = picked()
    if (running || !source?.available) return
    running = true
    controls()
    ct.browserImportStart(source.id, profile.id)
  }

  function close(): void {
    if (running) ct.browserImportCancel()
    unsubscribe()
    unsubscribeProfiles()
    document.removeEventListener('keydown', onKey, true)
    scrim.remove()
    if (openSheet?.close === close) openSheet = null
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    // Escape closes the sheet, and must not reach the window, which it would close
    e.stopPropagation()
    e.preventDefault()
    close()
  }

  from.addEventListener('change', controls)
  const unsubscribe = ct.onBrowserImport(show)
  // a profile removed while its sheet is open: the sheet has no profile to import into, so it closes
  const unsubscribeProfiles = ct.onBrowserProfiles((v) => {
    if (!v.profiles.some((p) => p.id === profile.id)) close()
  })
  document.addEventListener('keydown', onKey, true)
  document.body.append(scrim)
  openSheet = { profileId: profile.id, running: () => running, close }
  show({ state: 'idle' })
  loadSources()
}

/** opens the import sheet of the profile with this id (the Browser panel's menu names it, through the Settings section) */
export function openImportSheet(profileId: string): void {
  void ct.browserProfiles().then((v) => {
    const found = v.profiles.find((p) => p.id === profileId)
    if (found) importSheet(found)
  })
}

/**
 * Settings › Browser: the profiles of the Browser, each with its name, its default radio, its always-allowed sites, its data and
 * its delete; an Add profile field sits under the list. Main has the profiles: every change is answered with the list, and a
 * change made in another window arrives as the same list.
 */
export function browserSection(): HTMLElement {
  const list = el('div', { className: 'browser-profiles' })
  const render = (v: BrowserProfilesView): void => {
    list.replaceChildren(...v.profiles.map((p) => profileRow(p, v.defaultId, render)))
  }

  const addName = el('input', { type: 'text', spellcheck: false, className: 'text-input browser-add-name', placeholder: 'Profile name' })
  const submit = (): void => {
    const name = addName.value.trim()
    void ct.browserProfileAction({ type: 'add', name }).then((v) => {
      // the field is cleared once the profile is in the list; a refused name keeps what the person typed
      if (v.profiles.some((p) => p.name === name)) addName.value = ''
      render(v)
    })
  }
  addName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit()
  })
  const addRow = el('div', { className: 'browser-add' }, addName, button('Add', 'primary', submit))

  const sec = section('Browser', 'profiles keep their own cookies, storage and always-allowed sites', list, addRow)
  sec.id = 'browser'
  ct.onBrowserProfiles(render)
  void ct.browserProfiles().then(render)
  return sec
}
