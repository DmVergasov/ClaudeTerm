import '@fontsource-variable/inter'
import './settings.css'
import type { SettingsView } from '../shared/ipc'
import { REMOTE_COPY } from '../shared/remote'
import { MAX_AUTO_CONTINUES, NOTIFICATION_CASES, NOTIFICATION_CHANNELS, NUMBER_LIMITS } from '../shared/settings-keys'
import { DEFAULT_TEST_PATTERNS } from '../shared/test-files'
import type { NotificationCase, NotificationChannels } from '../shared/types'
import { accountsSection } from './accounts-section'
import { helperOpen, openHelper } from './account-helper'
import { devicesSection } from './devices-section'
import { el, loadInter, section } from './dom'
import { icon } from './icons'
import { applyView, cardSection, checkbox, currentView, errorLine, listRow, numberRow, save, selectRow, showAll, switchRow, textRow, type ShowError } from './settings-controls'
import { checkNumber, checkOptionalText, checkText, profileOptions, profileValue, soundChoice, themeChoices, type Option, type ThemeChoice } from './settings-form'
import { countLabel, matchesQuery, matchRanges, queryWords } from './settings-search'

// the bundled Inter is a local file: the wait is a frame or two, before any element is built
await loadInter()

const ct = window.ct
document.body.classList.add(`platform-${ct.platform}`)

type TabId = 'general' | 'appearance' | 'claude' | 'notifications' | 'panels' | 'accounts' | 'devices'

/** the tabs in the order of the nav, each with its page */
const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'panels', label: 'Panels' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'devices', label: 'Devices' }
]

// the tab in front when no search runs; a search is on when the field has words, and then its results are narrowed to filter:
// 'results' for all of them, or one tab's id
let current: TabId = 'general'
let searchOn = false
let filter: TabId | 'results' | null = null

const CASE_LABELS: Record<NotificationCase, string> = {
  permission: 'Claude asks for permission',
  question: 'Claude asks a question',
  done: 'Claude finished its answer',
  peer: 'A turn another session started',
  bell: 'Terminal bell'
}
/** the note under a case's name in the table: only the turn another session started has one */
const CASE_NOTES: Partial<Record<NotificationCase, string>> = { peer: 'Claude answered a message from another agent' }
const CHANNEL_LABELS: Record<keyof NotificationChannels, string> = { sound: 'Sound', flash: 'Taskbar flash', banner: 'Notification', tab: 'Tab highlight', front: 'Even in front' }
const CONPTY_OPTIONS: Option[] = [{ value: 'bundled', label: 'Bundled with ClaudeTerm' }, { value: 'system', label: "Windows' own" }]
const TEST_FILES_HINT = 'One pattern per line, matched against the path inside the project: * and ? within a name, ** across folders; a pattern without / matches the file name in any folder. Case-sensitive.'

function notificationTable(): HTMLElement {
  const e = errorLine()
  const head = el('tr', {}, el('th'), ...NOTIFICATION_CHANNELS.map((ch) => el('th', {
    textContent: CHANNEL_LABELS[ch],
    ...(ch === 'front' ? { title: 'Also while you look at the tab: its sound plays' } : {})
  })))
  const rows = NOTIFICATION_CASES.map((c) => {
    const note = CASE_NOTES[c]
    return el('tr', {},
      el('th', { scope: 'row' }, el('span', { className: 'rl', textContent: CASE_LABELS[c] }), ...(note ? [el('span', { className: 'rd', textContent: note })] : [])),
      ...NOTIFICATION_CHANNELS.map((ch) => el('td', {}, checkbox(`notifications.${c}.${ch}`, (v) => v.settings.notifications[c][ch], e.show, `${CASE_LABELS[c]}: ${CHANNEL_LABELS[ch]}`)))
    )
  })
  return el('div', {}, el('table', { className: 'notify' }, el('thead', {}, head), el('tbody', {}, ...rows)), e.line)
}

/** the picture on a sound's card: the icon in its box */
const iconBox = (svg: string): HTMLElement => el('span', { className: 'ico', innerHTML: svg })

/** the sound of the notifications: the system's sound or a .wav of the user's, and a Play button for the sound in use */
function soundSection(): HTMLElement {
  const play = el('button', { type: 'button', className: 'ghost', innerHTML: `${icon('play', 12)}Play` })
  play.addEventListener('click', () => ct.playSound())
  const playRow = el('div', { className: 'sound-play' }, play, el('span', { className: 'rd', textContent: 'Plays the sound in use' }))
  // a file is picked and saved; cancelled, the cards go back to the sound in use
  const pickFile = async (error: ShowError): Promise<void> => {
    const file = await ct.pickSound()
    if (file) await save('notifications.sound', file, error)
    else showAll()
  }
  return cardSection({
    title: 'Sound', key: 'notifications.sound', searchText: 'Windows default System sound The sound your system uses for notifications Custom .wav Pick a file; it plays for every case above',
    choices: (v) => {
      const s = soundChoice(v.settings.notifications.sound)
      return [
        { value: 'system', title: ct.platform === 'win32' ? 'Windows default' : 'System sound', note: 'The sound your system uses for notifications', art: iconBox(icon('volume', 17)) },
        { value: 'custom', title: 'Custom .wav', note: s.custom ? s.path : 'Pick a file; it plays for every case above', noteClass: 'sound-path', art: iconBox(icon('music', 17)) }
      ]
    },
    selected: (v) => (soundChoice(v.settings.notifications.sound).custom ? 'custom' : 'system'),
    pick: (value, error) => {
      if (value === 'custom') void pickFile(error)
      else if (soundChoice(currentView().settings.notifications.sound).custom) void save('notifications.sound', 'system', error)
    },
    after: playRow
  })
}

/** the picture on a theme's card: three lines of a terminal in the theme's colors, its cursor last */
function swatch(c: ThemeChoice['colors']): HTMLElement {
  const s = el('span', { className: 'swatch' })
  s.setAttribute('aria-hidden', 'true')
  s.style.background = c.background
  s.style.color = c.foreground
  const passed = el('span', { textContent: '✓ 42 passed' })
  passed.style.color = c.green
  const cursor = el('span', { className: 'swatch-cursor' })
  cursor.style.background = c.cursor
  s.append(el('span', { textContent: '$ npm test' }), passed, el('span', {}, '$ ', cursor))
  return s
}

/** the picture on a card of the tabs or the panels: a window with its tabs on top, or its list on the left, or its panel where it goes */
function artOf(kind: string, ...parts: HTMLElement[]): HTMLElement {
  const a = el('span', { className: `art ${kind}` }, ...parts)
  a.setAttribute('aria-hidden', 'true')
  return a
}

const topArt = (): HTMLElement => artOf('art-top', el('span', { className: 'art-tabs' }, el('i'), el('i'), el('i')), el('span', { className: 'art-sheet' }))
const leftArt = (): HTMLElement => artOf('art-left', el('span', { className: 'art-list' }, el('i'), el('i'), el('i')), el('span', { className: 'art-sheet' }))
const panelArt = (kind: 'art-overlay' | 'art-narrow'): HTMLElement => artOf(kind, el('span', { className: 'art-sheet' }), el('span', { className: 'art-panel' }))

const openFile = (): HTMLButtonElement => {
  const b = el('button', { type: 'button', className: 'ghost', textContent: 'Open settings.json' })
  b.addEventListener('click', () => ct.openSettingsFile())
  return b
}

const bannerText = el('span')
const banner = el('div', { className: 'settings-banner', hidden: true }, bannerText, openFile())
const notice = el('div', { className: 'settings-notice', hidden: true })

const automatic = ct.platform === 'win32' ? 'PowerShell 7 if installed, else Windows PowerShell' : 'your login shell'

/** a tab's page: hidden unless it is the tab in front, which the window starts at General */
function tabPage(id: TabId, ...content: HTMLElement[]): HTMLElement {
  const page = el('div', { className: 'settings-page', hidden: id !== 'general' }, ...content)
  page.dataset.page = id
  return page
}

// the view of the Claude tabs: a change switches the open ones too, each as soon as nothing it runs would stop
const claudeSlot = el('div', { className: 'settings-slot' }, cardSection({
  title: 'Claude tabs show', key: 'claude.view', searchText: 'chat terminal view default open',
  choices: () => [
    { value: 'chat', title: 'Chat', note: "The conversation as a chat, with cards for Claude's questions and permissions", art: iconBox(icon('message-square', 17)) },
    { value: 'terminal', title: 'Terminal', note: 'Claude Code\'s own screen, as before', art: iconBox(icon('terminal', 17)) }
  ],
  selected: (v) => v.settings.claude.view,
  pick: (value, error) => void save('claude.view', value, error)
}))
claudeSlot.dataset.slot = 'claude-view'

// the lines under the pages: no setting matches, and how to clear the search
const searchEmpty = el('p', { className: 'search-empty', textContent: 'No settings match', hidden: true })
const searchHint = el('p', { className: 'search-hint rd', textContent: 'Esc clears the search', hidden: true })

const root = document.getElementById('settings')!
root.append(el('div', { className: 'settings-inner' },
  banner,
  notice,
  tabPage('general',
    section('Shells', null,
      selectRow({ label: 'Default shell', description: `New tabs open in it · Automatic: ${automatic}` }, 'defaultProfile', (v) => profileOptions(v.profiles, v.settings.defaultProfile), profileValue),
      textRow({ label: 'Default folder', description: 'New tabs open here; a Claude tab opens in the folder of the tab it is opened from · empty: your home folder' },
        'defaultFolder', (v) => v.settings.defaultFolder ?? '', checkOptionalText),
      ...(ct.platform === 'win32'
        ? [selectRow({ label: 'Console host', description: "How a shell talks to the window · applies to new tabs · Windows' own may leave lines of Claude Code's screen behind or double them" },
          'conpty', (v) => ({ options: CONPTY_OPTIONS, selected: v.settings.conpty }), (s) => s)]
        : [])),
    section('Updates', null,
      switchRow({ label: 'Check for updates automatically' }, 'autoUpdate', (v) => v.settings.autoUpdate))),
  tabPage('appearance',
    cardSection({
      title: 'Terminal theme', key: 'theme', small: true,
      searchText: "Graphite ClaudeTerm's own, in the window's colors Campbell Windows Terminal's default One Half Dark Soft contrast on slate One Half Light A light terminal in the dark window",
      choices: (v) => themeChoices(v.settings.theme).map((c) => ({ value: c.value, title: c.title, note: c.note, art: swatch(c.colors), selectable: c.selectable })),
      selected: (v) => themeChoices(v.settings.theme).find((c) => c.selected)?.value ?? '',
      pick: (value, error) => {
        if (value !== currentView().settings.theme) void save('theme', value, error)
      },
      after: el('p', { className: 'rd section-after', textContent: 'A theme of your own colors goes in settings.json and shows here as one more card.' })
    }),
    section('Terminal text', null,
      textRow({ label: 'Font', description: 'Any monospace font on this computer' }, 'font.family', (v) => v.settings.font.family, checkText),
      numberRow({ label: 'Size', description: 'In pixels; zooming the terminal does not change it' }, 'font.size', (v) => v.settings.font.size, (t) => checkNumber('font.size', t), { step: NUMBER_LIMITS['font.size'] }),
      numberRow({ label: 'Scrollback lines', description: 'Applies to new tabs' }, 'scrollback', (v) => v.settings.scrollback, (t) => checkNumber('scrollback', t))),
    cardSection({
      title: 'Tabs', key: 'tabs.position', searchText: 'On top A row of tabs above the sheet, grouped by project On the left A list beside the sheet, Recent sessions at its foot',
      choices: () => [
        { value: 'top', title: 'On top', note: 'A row of tabs above the sheet, grouped by project', chip: '"top"', art: topArt() },
        { value: 'left', title: 'On the left', note: 'A list beside the sheet, Recent sessions at its foot', chip: '"left"', art: leftArt() }
      ],
      selected: (v) => v.settings.tabs.position,
      pick: (value, error) => {
        // the card in use saves nothing: a click on it leaves settings.json as it is
        if (value !== currentView().settings.tabs.position) void save('tabs.position', value, error)
      }
    }),
    cardSection({
      title: 'Panels without room', key: 'sidePanel.noRoom', searchText: "Over the terminal Media and Changes cover the terminal's right side Narrow the terminal The terminal steps aside and gets narrower",
      choices: () => [
        { value: 'overlay', title: 'Over the terminal', note: "Media and Changes cover the terminal's right side", chip: '"overlay"', art: panelArt('art-overlay') },
        { value: 'narrow', title: 'Narrow the terminal', note: 'The terminal steps aside and gets narrower', chip: '"narrow"', art: panelArt('art-narrow') }
      ],
      selected: (v) => v.settings.sidePanel.noRoom,
      pick: (value, error) => {
        if (value !== currentView().settings.sidePanel.noRoom) void save('sidePanel.noRoom', value, error)
      },
      after: el('p', { className: 'rd section-after', textContent: 'The panels widen the window first. Maximized, or at the edge of the screen, it cannot widen.' })
    })),
  tabPage('claude',
    claudeSlot,
    section('Chat', null,
      switchRow({ label: 'Copy selected chat text', description: 'Text you select with the mouse in a chat goes to the clipboard, as in a terminal.' },
        'chat.copyOnSelect', (v) => v.settings.chat.copyOnSelect),
      switchRow({ label: 'Full-width chat', description: 'The conversation and the message box use the whole width of the window instead of a reading column.' },
        'chat.fullWidth', (v) => v.settings.chat.fullWidth),
      switchRow({ label: 'MCP problems in the status bar', description: 'The MCP segment turns red, amber or blue when a server failed, waits for a sign-in, or a change waits for a restart. Off: it only counts the servers.' },
        'chat.mcpAlerts', (v) => v.settings.chat.mcpAlerts)),
    section('Starting Claude', null,
      textRow({ label: 'Command', description: "What the tab's shell runs to start Claude · applies to new tabs" }, 'claude.command', (v) => v.settings.claude.command, checkText, true),
      selectRow({ label: 'Shell for Claude tabs', description: 'Applies to new tabs' }, 'claude.shellProfile', (v) => profileOptions(v.profiles, v.settings.claude.shellProfile), profileValue)),
    section('While Claude works', null,
      switchRow({ label: 'Continue a cut-off response', description: `When a dropped connection cuts a response off, up to ${MAX_AUTO_CONTINUES} times in a row` },
        'claude.autoContinue', (v) => v.settings.claude.autoContinue),
      switchRow({ label: 'Go on after a restart', description: 'The tabs ClaudeTerm restores pick up the work Claude was doing when it closed' },
        'claude.continueAfterRestore', (v) => v.settings.claude.continueAfterRestore),
      switchRow({ label: 'Go on after a usage limit', description: 'A turn the usage limit stopped goes on by itself a minute after the limit resets' },
        'claude.continueAfterLimit', (v) => v.settings.claude.continueAfterLimit),
      switchRow({ label: 'Heads up', description: 'In a chat, a side agent on Sonnet reads the conversation while Claude works and shows what you should know above the message box · uses your plan' },
        'claude.headsUp', (v) => v.settings.claude.headsUp),
      switchRow({ label: 'Pace of the usage limits', description: 'A bar and a color in the title bar from how fast each limit is spent' },
        'claude.limitPace', (v) => v.settings.claude.limitPace)),
    section('Status bar', null,
      switchRow({ label: 'Refresh on a timer', description: 'Off: the status bar updates with each message Claude sends' }, 'claude.statusRefresh', (v) => v.settings.claude.statusRefresh),
      numberRow({ label: 'Refresh every', description: '1–300 seconds; each refresh starts a few short processes per Claude tab' }, 'claude.statusRefreshInterval',
        (v) => v.settings.claude.statusRefreshInterval, (t) => checkNumber('claude.statusRefreshInterval', t),
        { suffix: 'seconds', off: (v) => !v.settings.claude.statusRefresh }))),
  tabPage('notifications',
    Object.assign(section('When a tab you are not looking at needs you', null, notificationTable()), { id: 'notifications' }),
    soundSection(),
    section('More', null,
      switchRow({ label: 'Signal a finished answer during background work', description: 'Also while agents, shell commands or monitors Claude started still run' },
        'notifications.doneWithBackgroundWork', (v) => v.settings.notifications.doneWithBackgroundWork),
      switchRow({ label: 'Highlight a tab left unread', description: 'A Claude tab you leave with a reply not read to its end, or a prompt not sent' },
        'notifications.autoUnread', (v) => v.settings.notifications.autoUnread))),
  tabPage('panels',
    section('Media', null,
      switchRow({ label: 'Show new images, audio and video from the session scratchpad', description: 'Applies to new tabs' }, 'imageWatch.enabled', (v) => v.settings.imageWatch.enabled),
      switchRow({ label: 'Open the Media panel when a new file arrives', description: 'Applies to new tabs' }, 'imagePanel.autoOpen', (v) => v.settings.imagePanel.autoOpen)),
    section('Changes', null,
      textRow({ label: 'Editor', description: 'Empty: VS Code if installed, else the file is shown in its folder · {file} and {line} are filled in' },
        'review.editor', (v) => v.settings.review.editor ?? '', checkOptionalText),
      switchRow({ label: 'Show the changes counter in the status bar' }, 'review.statusBar', (v) => v.settings.review.statusBar),
      switchRow({ label: 'Hide files git ignores' }, 'review.hideIgnored', (v) => v.settings.review.hideIgnored),
      switchRow({ label: 'Hide test files' }, 'review.hideTests', (v) => v.settings.review.hideTests),
      switchRow({ label: 'Show Markdown files formatted' }, 'review.renderMarkdown', (v) => v.settings.review.renderMarkdown),
      listRow({ label: 'Test files', description: TEST_FILES_HINT }, 'review.testPatterns', (v) => v.settings.review.testPatterns, DEFAULT_TEST_PATTERNS)),
    section('Agent messages', null,
      switchRow({ label: "Let agents message tabs that Claude Code's own messaging can't reach", description: "Agents use SendMessage first. ClaudeTerm carries a message only to a tab SendMessage doesn't list: another device, another account." },
        'agentMessages.enabled', (v) => v.settings.agentMessages.enabled),
      switchRow({ label: "Mark tabs that got messages you haven't read", description: 'An envelope on the tab and a counter; no sound, no pop-up.' },
        'agentMessages.marks', (v) => v.settings.agentMessages.marks))),
  tabPage('accounts', accountsSection()),
  tabPage('devices', devicesSection([switchRow({ label: REMOTE_COPY.keepAwake }, 'devices.keepAwake', (v) => v.settings.devices.keepAwake)])),
  searchEmpty,
  searchHint
))

// a whole section is one search unit: what a search finds it by is its text and the extra words; the rows in it are no units
markUnit(document.getElementById('notifications')!, 'notifications sound flash banner tab front')
markUnit(document.querySelector<HTMLElement>('.settings-page[data-page="accounts"] .settings-section')!, '')
markUnit(document.getElementById('devices')!, '')
// every section title carries the name of its tab, shown as a crumb while a search runs
for (const page of document.querySelectorAll<HTMLElement>('.settings-page')) {
  const name = TABS.find((t) => t.id === page.dataset.page)!.label
  for (const title of page.querySelectorAll<HTMLElement>('h2.section-title')) title.append(el('span', { className: 'crumb', innerHTML: `${name}${icon('chevron-right', 10)}` }))
}

// the head: the search field and the nav of the tabs
const headInner = el('div', { className: 'settings-head-inner' })
headInner.innerHTML = `<label class="settings-search">${icon('search', 15)}<input id="settings-search" type="search" aria-label="Search settings" placeholder="Search settings" spellcheck="false" autocomplete="off"><span class="search-count" hidden></span><button type="button" class="search-clear" aria-label="Clear the search" hidden>${icon('x', 11)}</button><kbd class="search-key">${ct.platform === 'darwin' ? '⌘F' : 'Ctrl+F'}</kbd></label>`
const searchField = headInner.querySelector<HTMLInputElement>('#settings-search')!
const searchCount = headInner.querySelector<HTMLElement>('.search-count')!
const clearButton = headInner.querySelector<HTMLButtonElement>('.search-clear')!
const searchKey = headInner.querySelector<HTMLElement>('.search-key')!
const nav = el('nav', { id: 'settings-nav' })
nav.setAttribute('aria-label', 'Settings sections')
// the results tab is in front only while a search runs
const resultsTab = el('button', { type: 'button', className: 'settings-tab', hidden: true }, 'All results', el('span', { className: 'n' }))
resultsTab.dataset.tab = 'results'
resultsTab.addEventListener('click', () => pick('results'))
nav.append(resultsTab)
for (const t of TABS) {
  const tab = el('button', { type: 'button', className: 'settings-tab', textContent: t.label }, el('span', { className: 'n', hidden: true }))
  tab.dataset.tab = t.id
  tab.addEventListener('click', () => pick(t.id))
  nav.append(tab)
}
headInner.append(nav)
document.getElementById('settings-head')!.append(headInner)
showTab('general')
searchField.addEventListener('input', applySearch)
clearButton.addEventListener('click', () => {
  clearSearch()
  searchField.focus()
})

// the footer: changes are saved as they are made, and the settings file is one click away
const saved = el('span', { className: 'saved' })
saved.innerHTML = `${icon('check', 13)}Saved as you change it`
document.getElementById('settings-footer')!.append(saved,
  el('span', { className: 'footer-note', textContent: 'Profiles, image types, ignored folders, a custom theme and the image and Changes panel widths are set in settings.json' }),
  openFile())

/** shows a tab's page and marks its tab current; the page starts at its top */
function showTab(id: TabId): void {
  current = id
  for (const page of document.querySelectorAll<HTMLElement>('.settings-page')) page.hidden = page.dataset.page !== id
  markTab(id)
  root.scrollTop = 0
}

/** marks the tab with this id as the current one, and no other */
function markTab(id: string): void {
  for (const tab of document.querySelectorAll<HTMLElement>('#settings-nav .settings-tab')) {
    if (tab.dataset.tab === id) tab.setAttribute('aria-current', 'page')
    else tab.removeAttribute('aria-current')
  }
}

/** a section as one search unit: what a search finds it by is its text at build time and the extra words; the rows in it are no units */
function markUnit(section: HTMLElement, extra: string): void {
  section.classList.add('search-unit')
  section.dataset.search = `${section.textContent} ${extra}`
  for (const inner of section.querySelectorAll<HTMLElement>('.search-unit')) inner.classList.remove('search-unit')
}

/** a tab's click: while a search runs, it narrows the results to that tab; with none, it shows the tab's page */
function pick(id: TabId | 'results'): void {
  if (searchOn) {
    filter = id
    applySearch()
  } else if (id !== 'results') showTab(id)
}

/** the search: with words, the settings that have every word are shown, marked and counted, and the tabs narrow to them; with none, the tab in front is back */
function applySearch(): void {
  const words = queryWords(searchField.value)
  const wasOn = searchOn
  searchOn = words.length > 0
  filter = searchOn ? (filter ?? 'results') : null
  document.body.classList.toggle('searching', searchOn)
  for (const mark of document.querySelectorAll<HTMLElement>('mark.search-hit')) {
    const parent = mark.parentNode!
    mark.replaceWith(mark.textContent ?? '')
    parent.normalize()
  }
  for (const unit of document.querySelectorAll<HTMLElement>('.search-unit')) unit.hidden = !matchesQuery(unit.dataset.search ?? '', words)
  for (const section of document.querySelectorAll<HTMLElement>('.settings-section')) {
    const shown = section.classList.contains('search-unit') ? !section.hidden : section.querySelector('.search-unit:not([hidden])') !== null
    section.hidden = searchOn && !shown
  }
  const counts = new Map<string, number>()
  let total = 0
  if (searchOn) {
    for (const page of document.querySelectorAll<HTMLElement>('.settings-page')) {
      const n = shownUnits(page).length
      counts.set(page.dataset.page ?? '', n)
      total += n
    }
    // the tab narrowed to has no match left: the results of all the tabs show again
    if (filter !== 'results' && (counts.get(filter ?? 'results') ?? 0) === 0 && total > 0) filter = 'results'
    for (const unit of shownUnits(document.body)) markHits(unit, words)
    // a page with no unit shown is hidden too, so it adds no gap between the pages that are shown
    for (const page of document.querySelectorAll<HTMLElement>('.settings-page')) page.hidden = (filter !== 'results' && page.dataset.page !== filter) || (counts.get(page.dataset.page ?? '') ?? 0) === 0
    markTab(filter ?? 'results')
  } else if (wasOn) showTab(current)
  searchCount.hidden = !searchOn
  searchCount.textContent = countLabel(total)
  clearButton.hidden = !searchOn
  searchKey.hidden = searchOn
  searchEmpty.hidden = !searchOn || total > 0
  searchHint.hidden = !searchOn || total === 0
  for (const tab of document.querySelectorAll<HTMLButtonElement>('#settings-nav .settings-tab')) {
    const badge = tab.querySelector<HTMLElement>('.n')!
    if (tab.dataset.tab === 'results') {
      tab.hidden = !searchOn
      badge.textContent = String(total)
      continue
    }
    const n = counts.get(tab.dataset.tab ?? '') ?? 0
    badge.textContent = searchOn ? String(n) : ''
    badge.hidden = !searchOn || n === 0
    tab.classList.toggle('none', searchOn && n === 0)
    tab.disabled = searchOn && n === 0
  }
}

/** the units under an element that the search shows: not hidden themselves, nor inside a hidden element (a page is hidden by the tab it is not on, so it does not count) */
function shownUnits(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.search-unit')].filter((unit) => !unit.hidden && unit.closest('[hidden]:not(.settings-page)') === null)
}

/** marks the words of the search in a unit's labels: each text node directly in a .rl, .rd, .ct-name or .cd is split into text and marks */
function markHits(unit: HTMLElement, words: string[]): void {
  for (const label of unit.querySelectorAll<HTMLElement>('.rl, .rd, .ct-name, .cd')) {
    for (const node of [...label.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE) continue
      const text = node.textContent ?? ''
      const ranges = matchRanges(text, words)
      if (ranges.length === 0) continue
      const parts: Node[] = []
      let at = 0
      for (const [start, end] of ranges) {
        if (start > at) parts.push(document.createTextNode(text.slice(at, start)))
        parts.push(el('mark', { className: 'search-hit', textContent: text.slice(start, end) }))
        at = end
      }
      if (at < text.length) parts.push(document.createTextNode(text.slice(at)))
      node.replaceWith(...parts)
    }
  }
}

/** empties the search field and goes back to the tab in front */
function clearSearch(): void {
  searchField.value = ''
  applySearch()
}

function render(v: SettingsView): void {
  banner.hidden = !v.locked
  bannerText.textContent = `settings.json can't be used: ${v.problems.map((p) => p.replace(/^settings\.json: /, '')).join(' ')}`
  notice.hidden = v.locked || v.problems.length === 0
  notice.replaceChildren(...v.problems.map((p) => el('div', { textContent: p })))
  applyView(v)
  // a hand edit redraws the settings: the search keeps its results
  applySearch()
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  // with text in the search field, Esc clears it; with none, Esc closes the window
  if (searchField.value === '') window.close()
  else {
    e.preventDefault()
    clearSearch()
  }
})

// Ctrl+F (Cmd+F on macOS) puts the focus in the search field, wherever the focus is
document.addEventListener('keydown', (e) => {
  // the helper is modal: the search field behind it does not take the focus
  if (helperOpen()) return
  if ((ct.platform === 'darwin' ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === 'KeyF') {
    e.preventDefault()
    searchField.focus()
    searchField.select()
  }
})

// the page scrolls here, so PageDown and PageUp scroll the page of the tab with no click first: a key press outside #settings
// and outside a text field
const TEXT_FIELDS = 'textarea, select, input[type="text"], input[type="number"], input[type="search"], input[type="password"]'
document.addEventListener('keydown', (e) => {
  if (e.key !== 'PageDown' && e.key !== 'PageUp') return
  if (!(e.target instanceof Element) || root.contains(e.target) || e.target.matches(TEXT_FIELDS)) return
  e.preventDefault()
  root.scrollTop += (e.key === 'PageDown' ? 1 : -1) * (root.clientHeight - 40)
})

ct.onSettingsView(render)
void ct.getSettingsView().then(render)

/** the sections a Settings window can be opened at, each with the tab it lives in: the #hash of a new window, or a section sent to an open one */
const SECTIONS = new Map<string, TabId>([['devices', 'devices'], ['notifications', 'notifications'], ['accounts', 'accounts'], ['add-account', 'accounts']])

function showSection(name: string): void {
  const tab = SECTIONS.get(name)
  if (!tab) return
  // the section is shown in its tab, not among the results of a search
  clearSearch()
  showTab(tab)
  // the add flow's helper opens over the page, once the page is in front
  if (name === 'add-account') void ct.listAccounts().then((accounts) => openHelper({ mode: 'add', account: null, accounts }))
  document.getElementById(name)?.scrollIntoView()
}

ct.onSettingsSection(showSection)
showSection(location.hash.slice(1))
// the page scrolls here, so a key press scrolls it with no click first: focused once, unless something else already has the focus
if (document.activeElement === document.body) root.focus({ preventScroll: true })
