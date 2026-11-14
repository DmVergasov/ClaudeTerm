import { describe, expect, it } from 'vitest'
import { avatarColor, helperTitle, initials, mainLine, primaryLabel, rowLine, shortPath, staysDismissed, tickRows } from '../../src/renderer/account-view'
import type { AccountView, CarryPreview } from '../../src/shared/accounts'

const home = 'C:\\Users\\rim28'
const base: AccountView = { id: 'x', name: 'Work', addedAt: '2026-10-14T10:00:00.000Z', kind: 'login', readable: true, state: 'ready', checking: false, email: 'work@example.com', plan: 'Max plan', folder: 'C:\\Users\\rim28\\.claude-accounts\\work' }
const token: AccountView = { ...base, id: 't', name: 'CI bot', kind: 'token', readable: true, state: null, email: null, plan: null, folder: null }

const preview: CarryPreview = {
  source: null,
  sourceName: 'Main account',
  sourceEmail: 'main@example.com',
  sourceFolder: home + '\\.claude',
  targetTabs: 0,
  items: [
    { item: 'settings', count: 1, names: [], marketplaces: 0 },
    { item: 'hooks', count: 2, names: [], marketplaces: 0 },
    { item: 'mcp', count: 4, names: ['alpha', 'beta', 'gamma'], marketplaces: 0 },
    { item: 'plugins', count: 2, names: [], marketplaces: 1 },
    { item: 'agents', count: 3, names: [], marketplaces: 0 },
    { item: 'memory', count: 2, names: [], marketplaces: 0 },
    { item: 'trust', count: 1, names: [], marketplaces: 0 },
    { item: 'keybindings', count: 1, names: [], marketplaces: 0 }
  ]
}

const withSecrets: CarryPreview = { ...preview, items: [...preview.items, { item: 'mcp-secrets', count: 1, names: ['alpha'], marketplaces: 0 }] }

describe('initials', () => {
  it('takes the first two characters, the first in upper case', () => {
    expect(initials('Main account')).toBe('Ma')
    expect(initials('work')).toBe('Wo')
    expect(initials('store')).toBe('St')
    expect(initials('CI')).toBe('CI')
    expect(initials('x')).toBe('X')
    expect(initials('')).toBe('')
  })
})

describe('avatarColor', () => {
  it('is the accent for Main account, the sign-in colours by index, and grey for a token', () => {
    expect(avatarColor(null, 0)).toEqual({ background: 'var(--accent)', color: '#111' })
    expect(avatarColor(base, 0).background).toBe('var(--blue)')
    expect(avatarColor(base, 1).background).toBe('var(--purple)')
    expect(avatarColor(base, 2).background).toBe('var(--green)')
    expect(avatarColor(base, 3).background).toBe('var(--amber)')
    expect(avatarColor(base, 4).background).toBe('var(--blue)')
    expect(avatarColor(token, 0)).toEqual({ background: '#3A3A43', color: '#B5B5BE' })
  })
})

describe('shortPath', () => {
  it('shows a path in the home folder from ~, with its separator kept', () => {
    expect(shortPath('C:\\Users\\rim28', home)).toBe('~')
    expect(shortPath('C:\\Users\\rim28\\proj', home)).toBe('~\\proj')
    expect(shortPath('C:\\Users\\rim28other\\proj', home)).toBe('C:\\Users\\rim28other\\proj')
    expect(shortPath('/srv/app', home)).toBe('/srv/app')
  })

  it('compares a Windows path without case and across slashes', () => {
    expect(shortPath('c:\\users\\RIM28\\proj', home)).toBe('~\\proj')
    expect(shortPath('C:/Users/rim28/proj', home)).toBe('~/proj')
  })

  it('compares any other path as it is', () => {
    expect(shortPath('/home/dev/app', '/home/dev')).toBe('~/app')
    expect(shortPath('/Home/dev/app', '/home/dev')).toBe('/Home/dev/app')
  })
})

describe('rowLine', () => {
  it('says Checking… until the first check answers', () => {
    expect(rowLine({ ...base, checking: true, state: null }, home)).toEqual({ tone: 'none', text: 'Checking…' })
  })

  it('a ready sign-in account shows its email, plan and folder', () => {
    expect(rowLine(base, home)).toEqual({ tone: 'ok', text: 'Signed in as work@example.com · Max plan · ~\\.claude-accounts\\work' })
  })

  it('leaves out the parts that are unknown', () => {
    expect(rowLine({ ...base, plan: null }, home).text).toBe('Signed in as work@example.com · ~\\.claude-accounts\\work')
    expect(rowLine({ ...base, email: null, plan: null, folder: null }, home).text).toBe('Signed in')
  })

  it('a signed-out account says the sign-in expired, with a warning', () => {
    expect(rowLine({ ...base, state: 'signed-out', readable: false }, home)).toEqual({ tone: 'warn', text: 'Not signed in — the sign-in expired or was revoked · ~\\.claude-accounts\\work' })
  })

  it('a missing folder says so', () => {
    expect(rowLine({ ...base, state: 'missing', readable: false }, home).text).toBe('Its folder is gone: ~\\.claude-accounts\\work')
  })

  it('an unknown state says the sign-in could not be checked', () => {
    expect(rowLine({ ...base, state: 'unknown' }, home).text).toBe('Could not check the sign-in · ~\\.claude-accounts\\work')
  })

  it('a token shows until when it is valid, and what it cannot do', () => {
    expect(rowLine(token, home)).toEqual({ tone: 'none', text: 'Token valid until about 14 Oct 2027 · model requests only: no connectors, no Remote Control' })
  })

  it('a token that cannot be read asks for a new one', () => {
    expect(rowLine({ ...token, readable: false }, home).text).toBe('Token cannot be read — replace it')
  })
})

describe('mainLine', () => {
  it('shows who is signed in to Main account, its plan and folder', () => {
    expect(mainLine({ email: 'main@example.com', plan: 'Max plan', folder: home + '\\.claude' }, home)).toBe('Signed in as main@example.com · Max plan · ~\\.claude')
    expect(mainLine({ email: null, plan: null, folder: null }, home)).toBe('Signed in')
  })
})

describe('tickRows', () => {
  it('lists every carried item in order, with its label, note and count', () => {
    const rows = tickRows(preview, { adopt: false, mode: 'add', targetName: 'Studio' })
    expect(rows.map((r) => r.item)).toEqual(['settings', 'hooks', 'mcp', 'plugins', 'skills', 'agents', 'commands', 'memory', 'trust', 'keybindings', 'output-styles'])
    expect(rows[0]).toEqual({ item: 'settings', label: 'Settings', note: 'Model, permissions, environment, status line', count: '1', ticked: true, disabled: false })
    expect(rows[1]).toMatchObject({ label: 'Hooks', note: 'Commands Claude Code runs on its events', count: '2', ticked: true })
    expect(rows[2]).toMatchObject({ label: 'MCP servers', note: 'alpha, beta, gamma +1 · sign-ins are asked again', count: '4' })
    expect(rows[3]).toMatchObject({ label: 'Plugins', note: 'Installed again from their 1 marketplace', count: '2' })
    expect(rows[5]).toMatchObject({ label: 'Agents', note: 'Your subagents', count: '3' })
    expect(rows[7]).toMatchObject({ label: 'Memory', note: 'CLAUDE.md and rules', count: '2 files' })
    expect(rows[9]).toMatchObject({ label: 'Keybindings', note: 'keybindings.json', count: '1 file' })
  })

  it('MCP app secrets come right after MCP servers, with the servers that have one, ticked by default; a preview without them has no such row', () => {
    const rows = tickRows(withSecrets, { adopt: false, mode: 'add', targetName: 'Studio' })
    expect(rows.map((r) => r.item).slice(2, 5)).toEqual(['mcp', 'mcp-secrets', 'plugins'])
    expect(rows[3]).toEqual({ item: 'mcp-secrets', label: 'MCP app secrets', note: 'alpha · client secrets of their own OAuth apps', count: '1', ticked: true, disabled: false })
    expect(tickRows(preview, { adopt: false, mode: 'add', targetName: 'Studio' }).some((r) => r.item === 'mcp-secrets')).toBe(false)
  })

  it('MCP app secrets are off while MCP servers is unticked, and follow its default tick otherwise', () => {
    const o = { adopt: false, mode: 'add' as const, targetName: 'Studio' }
    const secretsRow = (p: CarryPreview, over: { adopt?: boolean; mcpTicked?: boolean }) => tickRows(p, { ...o, ...over }).find((r) => r.item === 'mcp-secrets')
    expect(secretsRow(withSecrets, { mcpTicked: false })).toEqual({ item: 'mcp-secrets', label: 'MCP app secrets', note: 'Comes with the servers above', count: '1', ticked: false, disabled: true })
    expect(secretsRow(withSecrets, { mcpTicked: true })).toMatchObject({ ticked: true, disabled: false })
    expect(secretsRow(withSecrets, { adopt: true, mcpTicked: true })).toMatchObject({ ticked: false, disabled: false })
    // without mcpTicked the servers' own default decides: ticked unless the folder is adopted
    expect(secretsRow(withSecrets, {})).toMatchObject({ ticked: true, disabled: false })
    expect(secretsRow(withSecrets, { adopt: true })).toMatchObject({ ticked: false, disabled: true })
    const none: CarryPreview = { ...withSecrets, items: withSecrets.items.map((c) => (c.item === 'mcp-secrets' ? { ...c, count: 0, names: [] } : c)) }
    expect(secretsRow(none, { mcpTicked: false })?.note).toBe('None in Main account')
  })

  it('an item the source does not have is disabled and unticked, and says so', () => {
    const skills = tickRows(preview, { adopt: false, mode: 'add', targetName: 'Studio' })[4]
    expect(skills).toEqual({ item: 'skills', label: 'Skills', note: 'None in Main account', count: '0', ticked: false, disabled: true })
  })

  it('an adopted folder ticks nothing', () => {
    const rows = tickRows(preview, { adopt: true, mode: 'add', targetName: 'Studio' })
    expect(rows.every((r) => !r.ticked)).toBe(true)
    expect(rows.find((r) => r.item === 'skills')?.disabled).toBe(true)
    expect(rows.find((r) => r.item === 'settings')?.disabled).toBe(false)
  })

  it('trusted folders are off while the target has open tabs when carrying over', () => {
    const open = tickRows({ ...preview, targetTabs: 2 }, { adopt: false, mode: 'carry', targetName: 'Studio' }).find((r) => r.item === 'trust')
    expect(open).toEqual({ item: 'trust', label: 'Trusted folders', note: 'Close the tabs on Studio to carry over trusted folders', count: '1', ticked: false, disabled: true })
    const closed = tickRows(preview, { adopt: false, mode: 'carry', targetName: 'Studio' }).find((r) => r.item === 'trust')
    expect(closed).toMatchObject({ ticked: true, disabled: false })
  })
})

describe('helperTitle and primaryLabel', () => {
  it('titles the helper by its mode', () => {
    expect(helperTitle('add', 'Work')).toBe('Add a Claude account')
    expect(helperTitle('sign-in-again', 'Work')).toBe('Sign in to Work again')
    expect(helperTitle('to-login', 'Work')).toBe('Sign in instead of the token')
    expect(helperTitle('carry', 'Work')).toBe('Carry over to Work')
  })

  it('labels the primary button: Add once an adopted folder is signed in, Carry over when carrying', () => {
    expect(primaryLabel('add', null)).toBe('Sign in…')
    expect(primaryLabel('add', { signedIn: false })).toBe('Sign in…')
    expect(primaryLabel('add', { signedIn: true })).toBe('Add')
    expect(primaryLabel('carry', null)).toBe('Carry over')
  })
})

describe('staysDismissed', () => {
  it('keeps the helper closed for updates in the step it was dismissed at, and while the sign-in is confirmed', () => {
    expect(staysDismissed('sign-in', 'sign-in')).toBe(true)
    expect(staysDismissed('sign-in', 'confirming')).toBe(true)
  })
  it('brings it back for a step that needs the person', () => {
    expect(staysDismissed('sign-in', 'failed')).toBe(false)
    expect(staysDismissed('sign-in', 'same-login')).toBe(false)
    expect(staysDismissed('sign-in', 'done')).toBe(false)
  })
  it('does nothing when the helper was not dismissed', () => {
    expect(staysDismissed(null, 'sign-in')).toBe(false)
  })
})
