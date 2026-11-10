import { describe, expect, it } from 'vitest'
import { formatAgentList, nameAgents, resolveAgent } from '../../src/main/mail/agent-directory'
import type { Agent, AgentTab } from '../../src/main/mail/agent-directory'
import type { MailAddress } from '../../src/shared/mail'

const DEV_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const DEV_B = '9a1e2f3c-4d5b-4e6f-8a7b-1c2d3e4f5a6b'
const SES_A = '3be5d1f0-7c2a-4e9b-8d1f-6a5b4c3d2e1f'
const SES_B = 'c5df49a2-1b3c-4d5e-9f8a-7b6c5d4e3f2a'
const SES_C = 'c5df4900-0000-4000-8000-000000000001'
const SES_D = '7f00aa11-2233-4455-8677-8899aabbccdd'

const tab = (over: Partial<AgentTab> = {}): AgentTab => ({
  device: DEV_A,
  deviceName: 'Desktop',
  tabId: 'tab-1',
  session: SES_A,
  customTitle: null,
  folder: 'D:\\Work\\api-server',
  branch: null,
  title: null,
  busy: false,
  wakes: true,
  claude: '2.1.300',
  ...over
})

const agentOf = (over: Partial<AgentTab> = {}): Agent => nameAgents([tab(over)])[0]

describe('nameAgents', () => {
  it('the name is the custom title, else the folder\'s last part, then " · " and the device name', () => {
    const [plain] = nameAgents([tab({ customTitle: null, folder: 'D:\\Work\\api-server', deviceName: 'Desktop' })])
    expect(plain.name).toBe('api-server · Desktop')

    const [renamed] = nameAgents([tab({ customTitle: 'Revenue', folder: 'D:\\Work\\api-server' })])
    expect(renamed.name).toBe('Revenue · Desktop')

    const [blank] = nameAgents([tab({ customTitle: '   ', folder: '/home/sam/acme-dashboard/' })])
    expect(blank.name).toBe('acme-dashboard · Desktop')
  })

  it('the label of a root folder is the folder itself', () => {
    const [root] = nameAgents([tab({ folder: '/' })])
    expect(root.name).toBe('/ · Desktop')
  })

  it('two agents with one name on one device get " #2", " #3" in tab order', () => {
    const agents = nameAgents([
      tab({ tabId: 't1', session: SES_A }),
      tab({ tabId: 't2', session: SES_B }),
      tab({ tabId: 't3', session: SES_C })
    ])
    expect(agents.map(a => a.name)).toEqual([
      'api-server · Desktop',
      'api-server · Desktop #2',
      'api-server · Desktop #3'
    ])
  })

  it('agents on different devices with one label do not get a suffix', () => {
    const agents = nameAgents([
      tab({ device: DEV_A, deviceName: 'Desktop' }),
      tab({ device: DEV_B, deviceName: 'MacBook', session: SES_B })
    ])
    expect(agents.map(a => a.name)).toEqual(['api-server · Desktop', 'api-server · MacBook'])
  })

  it('a custom title of 500 characters is cut to 120, the last one an ellipsis, so the name is at most 200 characters', () => {
    const [long] = nameAgents([tab({ customTitle: 'x'.repeat(500) })])
    expect(long.name).toBe(`${'x'.repeat(119)}… · Desktop`)
    expect(long.name.length).toBeLessThanOrEqual(200)
  })

  it('a title with a newline and a bell is one plain line, its runs of spaces collapsed', () => {
    const [clean] = nameAgents([tab({ customTitle: 'Line one\n\u0007   two\t' })])
    expect(clean.name).toBe('Line one two · Desktop')
    const [separators] = nameAgents([tab({ customTitle: 'a b c' })])
    expect(separators.name).toBe('a b c · Desktop')
  })

  it('the device name keeps its length but loses its control characters', () => {
    const [named] = nameAgents([tab({ deviceName: 'Desk\ntop' })])
    expect(named.name).toBe('api-server · Desk top')
  })

  it('the ref is the first six characters of the session id, lower-cased', () => {
    const [agent] = nameAgents([tab({ session: 'ABC123DEF-0000-4000-8000-000000000000' })])
    expect(agent.ref).toBe('abc123')
  })
})

describe('formatAgentList', () => {
  it('writes one row per agent as the spec shows', () => {
    const agents = nameAgents([
      tab({ session: SES_A, branch: 'feat/revenue-units', title: 'Add a unit field to /v2/revenue' }),
      tab({
        device: DEV_B,
        deviceName: 'MacBook',
        session: SES_B,
        folder: '/Users/sam/acme-dashboard',
        customTitle: null,
        branch: 'main',
        title: 'Plot monthly revenue',
        busy: true
      })
    ])
    expect(formatAgentList(agents, [])).toBe(
      [
        'api-server · Desktop [3be5d1] · idle · D:\\Work\\api-server · feat/revenue-units · "Add a unit field to /v2/revenue"',
        'acme-dashboard · MacBook [c5df49] · busy · /Users/sam/acme-dashboard · main · "Plot monthly revenue"'
      ].join('\n')
    )
  })

  it('a title with a newline is one row: its control characters become spaces', () => {
    const agents = nameAgents([tab({ title: 'Plot\nmonthly\trevenue', branch: 'feat\u0007x', folder: 'D:\\Work\\a\nb' })])
    expect(formatAgentList(agents, [])).toBe('a b · Desktop [3be5d1] · idle · D:\\Work\\a b · feat x · "Plot monthly revenue"')
    const separated = nameAgents([tab({ title: 'x\u2028y\u2029z' })])
    expect(formatAgentList(separated, [])).toContain('· "x y z"')
  })

  it('leaves out the branch and the title when they are null', () => {
    const agents = nameAgents([tab({ branch: null, title: null })])
    expect(formatAgentList(agents, [])).toBe('api-server · Desktop [3be5d1] · idle · D:\\Work\\api-server')
  })

  it('an agent that cannot be woken is not a row but a line with its Claude Code version', () => {
    const agents = nameAgents([tab({ wakes: false, claude: '2.1.200' })])
    expect(formatAgentList(agents, [])).toBe(
      "No other agents. Agents on paired devices show here while their device is connected.\n" +
        "api-server · Desktop: Claude Code 2.1.200 can't receive messages; 2.1.287 or later can"
    )
  })

  it('says "of unknown version" when the Claude Code version is unknown', () => {
    const agents = nameAgents([tab({ wakes: false, claude: null })])
    expect(formatAgentList(agents, [])).toBe(
      "No other agents. Agents on paired devices show here while their device is connected.\n" +
        "api-server · Desktop: Claude Code of unknown version can't receive messages; 2.1.287 or later can"
    )
  })

  it('rows come first, then the can\'t-receive lines in input order, then the devices that do not accept', () => {
    const agents = nameAgents([
      tab({ tabId: 't1', session: SES_A, wakes: false, claude: '2.1.200' }),
      tab({ tabId: 't2', session: SES_B, device: DEV_B, deviceName: 'MacBook', folder: '/Users/sam/acme' }),
      tab({ tabId: 't3', session: SES_C, folder: 'D:\\Work\\other', wakes: false, claude: null })
    ])
    expect(formatAgentList(agents, ['Laptop'])).toBe(
      [
        'acme · MacBook [c5df49] · idle · /Users/sam/acme',
        "api-server · Desktop: Claude Code 2.1.200 can't receive messages; 2.1.287 or later can",
        "other · Desktop: Claude Code of unknown version can't receive messages; 2.1.287 or later can",
        'Laptop: does not accept agent messages'
      ].join('\n')
    )
  })

  it('a device that does not accept is listed on its own line, even when no agent is listed', () => {
    expect(formatAgentList([], ['MacBook'])).toBe(
      'No other agents. Agents on paired devices show here while their device is connected.\n' +
        'MacBook: does not accept agent messages'
    )
  })

  it('with nothing it gives the "No other agents" sentence', () => {
    expect(formatAgentList([], [])).toBe(
      'No other agents. Agents on paired devices show here while their device is connected.'
    )
  })
})

describe('resolveAgent', () => {
  const api = agentOf({ session: SES_A })
  const dash = agentOf({ device: DEV_B, deviceName: 'MacBook', session: SES_B, folder: '/Users/sam/acme-dashboard' })
  const recent: MailAddress = { device: DEV_B, session: SES_D, name: 'Offline Reviewer' }

  it('an empty to, or one that is only brackets, answers the not-found error', () => {
    expect(resolveAgent('', [api, dash], [recent])).toEqual({ ok: false, error: 'No agent named ""; call list_agents.' })
    expect(resolveAgent('[]', [api, dash], [recent])).toEqual({ ok: false, error: 'No agent named "[]"; call list_agents.' })
  })

  it('two devices with one device name and one label give the "matches more than one agent" error for the name', () => {
    const twin = agentOf({ device: DEV_B, deviceName: 'Desktop', session: SES_B })
    expect(twin.name).toBe(api.name)
    expect(resolveAgent('api-server · Desktop', [api, twin], [])).toEqual({
      ok: false,
      error: 'Name "api-server · Desktop" matches more than one agent: api-server · Desktop, api-server · Desktop.'
    })
  })

  it('finds an agent by its name, ignoring case and surrounding spaces', () => {
    const r = resolveAgent('  API-SERVER · desktop ', [api, dash], [])
    expect(r).toEqual({
      ok: true,
      to: { device: DEV_A, session: SES_A, name: 'api-server · Desktop' },
      agent: api
    })
  })

  it('finds an agent by its ref, also in the [ref] form', () => {
    expect(resolveAgent('3BE5D1', [api, dash], [])).toMatchObject({ ok: true, agent: api })
    expect(resolveAgent('[c5df49]', [api, dash], [])).toEqual({
      ok: true,
      to: { device: DEV_B, session: SES_B, name: 'acme-dashboard · MacBook' },
      agent: dash
    })
  })

  it('finds a recent address by its name and returns it as the target with no agent', () => {
    expect(resolveAgent('offline reviewer', [api], [recent])).toEqual({ ok: true, to: recent, agent: null })
  })

  it('finds a recent address by its ref, as the reply of a message from an agent that is not listed says to', () => {
    expect(resolveAgent('7F00AA', [api], [recent])).toEqual({ ok: true, to: recent, agent: null })
    expect(resolveAgent('[7f00aa]', [api], [recent])).toEqual({ ok: true, to: recent, agent: null })
  })

  it('a ref two recent addresses share is an error naming both', () => {
    const other: MailAddress = { device: DEV_A, session: '7f00aa99-0000-4000-8000-000000000002', name: 'Second Reviewer' }
    expect(resolveAgent('7f00aa', [api], [recent, other])).toEqual({
      ok: false,
      error: 'Ref "7f00aa" matches more than one agent: Offline Reviewer, Second Reviewer; use the full name.'
    })
  })

  it('an unknown name is an error', () => {
    expect(resolveAgent('  nobody ', [api], [recent])).toEqual({
      ok: false,
      error: 'No agent named "nobody"; call list_agents.'
    })
    expect(resolveAgent('[nobody]', [api], [])).toEqual({
      ok: false,
      error: 'No agent named "[nobody]"; call list_agents.'
    })
  })

  it('a ref two agents share is an error naming both', () => {
    const twin = agentOf({ device: DEV_B, deviceName: 'MacBook', session: SES_A + '' })
    expect(resolveAgent('3be5d1', [api, twin], [])).toEqual({
      ok: false,
      error: 'Ref "3be5d1" matches more than one agent: api-server · Desktop, api-server · MacBook; use the full name.'
    })
  })

  it('an agent that cannot be woken gives its can\'t-receive line when its name or ref is used', () => {
    const old = agentOf({ session: SES_C, folder: 'D:\\Work\\legacy', wakes: false, claude: '2.1.200' })
    const line = "legacy · Desktop: Claude Code 2.1.200 can't receive messages; 2.1.287 or later can"
    expect(resolveAgent('legacy · Desktop', [old], [])).toEqual({ ok: false, error: line })
    expect(resolveAgent('c5df49', [old], [])).toEqual({ ok: false, error: line })
  })

  it('a ref matching a woken agent and a non-woken one resolves to the woken one', () => {
    const old = agentOf({ device: DEV_B, deviceName: 'MacBook', session: SES_A, folder: '/x/old', wakes: false, claude: null })
    expect(resolveAgent('3be5d1', [api, old], [])).toMatchObject({ ok: true, agent: api })
  })
})
