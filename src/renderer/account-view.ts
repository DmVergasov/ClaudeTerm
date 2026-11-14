import { CARRY_ITEMS, CARRY_LABELS, type AccountView, type CarryCount, type CarryItem, type CarryPreview, type FlowMode, type MainAccountView } from '../shared/accounts'
import { validUntil } from './account-items'

/** the letters on an account's avatar: the first two characters, the first in upper case */
export function initials(name: string): string {
  const [first = '', ...rest] = Array.from(name).slice(0, 2)
  return first.toUpperCase() + rest.join('')
}

const SIGN_IN_COLOURS = ['var(--blue)', 'var(--purple)', 'var(--green)', 'var(--amber)']
const AVATAR_TEXT = '#111'

/** Main account on the accent, a sign-in account on one of the four colours by its index, a token grey */
export function avatarColor(a: AccountView | null, index: number): { background: string; color: string } {
  if (a === null) return { background: 'var(--accent)', color: AVATAR_TEXT }
  if (a.kind === 'token') return { background: '#3A3A43', color: '#B5B5BE' }
  const n = SIGN_IN_COLOURS.length
  return { background: SIGN_IN_COLOURS[((index % n) + n) % n], color: AVATAR_TEXT }
}

/** a path in the home folder reads from `~`: `C:\Users\me\app` is `~\app`; a Windows path compares without case and across slashes */
export function shortPath(path: string, home: string): string {
  const h = home.replace(/[\\/]+$/, '')
  if (h === '') return path
  const windows = /^[A-Za-z]:|\\/.test(path)
  const same = (s: string): string => (windows ? s.replace(/\//g, '\\').toLowerCase() : s)
  const p = same(path)
  const hk = same(h)
  if (p === hk) return '~'
  if (p.startsWith(hk) && /[\\/]/.test(p.charAt(hk.length))) return '~' + path.slice(h.length)
  return path
}

/** the parts that are known, joined with a middle dot */
function joined(...parts: (string | null)[]): string {
  return parts.filter((p): p is string => !!p).join(' · ')
}

function signedIn(email: string | null, plan: string | null, path: string | null): string {
  return joined(email ? `Signed in as ${email}` : 'Signed in', plan, path)
}

export interface RowLine {
  tone: 'ok' | 'warn' | 'none'
  text: string
}

/** an extra account's line in Settings: its state, and where it lives (a token shows until when it is valid) */
export function rowLine(a: AccountView, home: string): RowLine {
  if (a.kind === 'token') {
    return a.readable
      ? { tone: 'none', text: `Token valid until about ${validUntil(a.addedAt)} · model requests only: no connectors, no Remote Control` }
      : { tone: 'warn', text: 'Token cannot be read — replace it' }
  }
  if (a.checking) return { tone: 'none', text: 'Checking…' }
  const path = a.folder === null ? null : shortPath(a.folder, home)
  if (a.state === 'ready') return { tone: 'ok', text: signedIn(a.email, a.plan, path) }
  if (a.state === 'signed-out') return { tone: 'warn', text: joined('Not signed in — the sign-in expired or was revoked', path) }
  if (a.state === 'missing') return { tone: 'warn', text: path ? `Its folder is gone: ${path}` : 'Its folder is gone' }
  return { tone: 'none', text: joined('Could not check the sign-in', path) }
}

/** Main account's line: who is signed in there, and its folder */
export function mainLine(m: MainAccountView, home: string): string {
  return signedIn(m.email, m.plan, m.folder === null ? null : shortPath(m.folder, home))
}

export interface TickRow {
  item: CarryItem
  label: string
  note: string
  count: string
  ticked: boolean
  disabled: boolean
}

/** the carry picker's rows, in CARRY_ITEMS order: an item the source does not have is off; trusted folders wait for the target's tabs to close */
export function tickRows(p: CarryPreview, o: { adopt: boolean; mode: FlowMode; targetName: string }): TickRow[] {
  return CARRY_ITEMS.map((item) => {
    const c = p.items.find((x) => x.item === item)
    const n = c?.count ?? 0
    const blocked = item === 'trust' && o.mode === 'carry' && p.targetTabs > 0
    const disabled = n === 0 || blocked
    const note = n === 0 ? `None in ${p.sourceName}` : blocked ? `Close the tabs on ${o.targetName} to carry over trusted folders` : noteOf(item, c)
    return { item, label: CARRY_LABELS[item], note, count: countOf(item, n), ticked: !o.adopt && !disabled, disabled }
  })
}

function noteOf(item: CarryItem, c: CarryCount | undefined): string {
  switch (item) {
    case 'settings':
      return 'Model, permissions, environment, status line'
    case 'hooks':
      return 'Commands Claude Code runs on its events'
    case 'mcp': {
      const names = c?.names ?? []
      const rest = (c?.count ?? 0) - names.length
      return `${names.join(', ')}${rest > 0 ? ` +${rest}` : ''} · sign-ins are asked again`
    }
    case 'plugins': {
      const m = c?.marketplaces ?? 0
      return `Installed again from their ${m} ${m === 1 ? 'marketplace' : 'marketplaces'}`
    }
    case 'skills':
      return 'Your skills for every project'
    case 'agents':
      return 'Your subagents'
    case 'commands':
      return 'Your slash commands'
    case 'memory':
      return 'CLAUDE.md and rules'
    case 'trust':
      return 'Chats open in them without the trust question'
    case 'keybindings':
      return 'keybindings.json'
    case 'output-styles':
      return 'Your output styles'
  }
}

function countOf(item: CarryItem, n: number): string {
  if (item === 'memory' || item === 'keybindings') return `${n} ${n === 1 ? 'file' : 'files'}`
  return String(n)
}

export function helperTitle(mode: FlowMode, name: string): string {
  switch (mode) {
    case 'add':
      return 'Add a Claude account'
    case 'sign-in-again':
      return `Sign in to ${name} again`
    case 'to-login':
      return 'Sign in instead of the token'
    case 'carry':
      return `Carry over to ${name}`
  }
}

/** the helper's primary button: Carry over when carrying, Add once an adopted folder is signed in, else Sign in… */
export function primaryLabel(mode: FlowMode, adopt: { signedIn: boolean } | null): string {
  if (mode === 'carry') return 'Carry over'
  return adopt?.signedIn ? 'Add' : 'Sign in…'
}
