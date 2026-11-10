import { MAIL_MIN_CLAUDE, type MailAddress } from '../../shared/mail'

/** one Claude tab that could be an agent, as the tab manager and the devices report it */
export interface AgentTab {
  device: string | null
  deviceName: string
  tabId: string
  session: string
  customTitle: string | null
  folder: string
  branch: string | null
  title: string | null
  busy: boolean
  wakes: boolean
  claude: string | null
}

export interface Agent extends AgentTab {
  name: string
  ref: string
}

export type Resolved = { ok: true; to: MailAddress; agent: Agent | null } | { ok: false; error: string }

const NONE = 'No other agents. Agents on paired devices show here while their device is connected.'

/** the control characters, and the line and paragraph separators, which some readers take for a line break */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const LABEL_MAX = 120

/** the ref an agent is listed and addressed by: the first six characters of its session id, lower-cased */
export function refOf(session: string): string {
  return session.slice(0, 6).toLowerCase()
}

/** each control character becomes a space: a name, a folder or a title is one plain line in the text of a message */
export function replaceControls(text: string): string {
  return text.replace(CONTROL, ' ')
}

/** the label of a tab: its own title when the user renamed it, else the last part of its folder; one line, at most 120 characters */
function labelOf(tab: AgentTab): string {
  const custom = tab.customTitle?.trim()
  let label = custom
  if (!label) {
    const parts = tab.folder.replace(/[\\/]+$/, '').split(/[\\/]/)
    const last = parts[parts.length - 1]
    label = last === '' ? tab.folder : last
  }
  const flat = replaceControls(label).replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > LABEL_MAX ? `${chars.slice(0, LABEL_MAX - 1).join('')}…` : flat
}

function cantReceive(agent: Agent): string {
  const version = agent.claude === null ? 'of unknown version' : agent.claude
  return `${agent.name}: Claude Code ${version} can't receive messages; ${MAIL_MIN_CLAUDE} or later can`
}

/** names and refs the agents; two with one name on one device get " #2", " #3" in tab order */
export function nameAgents(tabs: AgentTab[]): Agent[] {
  const seen = new Map<string, number>()
  return tabs.map(tab => {
    const base = `${labelOf(tab)} · ${replaceControls(tab.deviceName)}`
    const key = JSON.stringify([tab.device, base])
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    const name = count === 1 ? base : `${base} #${count}`
    return { ...tab, name, ref: refOf(tab.session) }
  })
}

/** the text of list_agents: one row per agent that can be woken, then the lines explaining the rest */
export function formatAgentList(agents: Agent[], notAccepting: string[]): string {
  const rows: string[] = []
  const others: string[] = []
  for (const agent of agents) {
    if (!agent.wakes) {
      others.push(cantReceive(agent))
      continue
    }
    let row = `${agent.name} [${agent.ref}] · ${agent.busy ? 'busy' : 'idle'} · ${replaceControls(agent.folder)}`
    if (agent.branch !== null) row += ` · ${replaceControls(agent.branch)}`
    if (agent.title !== null) row += ` · "${replaceControls(agent.title)}"`
    rows.push(row)
  }
  for (const device of notAccepting) others.push(`${device}: does not accept agent messages`)
  if (rows.length === 0) rows.push(NONE)
  return [...rows, ...others].join('\n')
}

/** resolves the `to` of message_agent to an address, by name, then ref, then a recent address by name */
export function resolveAgent(to: string, agents: Agent[], recent: MailAddress[]): Resolved {
  const trimmed = to.trim()
  let key = trimmed
  if (key.length >= 2 && key.startsWith('[') && key.endsWith(']')) key = key.slice(1, -1).trim()
  const lower = key.toLowerCase()
  const notFound = { ok: false as const, error: `No agent named "${trimmed}"; call list_agents.` }

  const woken = agents.filter(agent => agent.wakes)
  const byName = woken.filter(agent => agent.name.toLowerCase() === lower)
  if (byName.length === 1) return found(byName[0])
  if (byName.length > 1) {
    return { ok: false, error: `Name "${key}" matches more than one agent: ${byName.map(a => a.name).join(', ')}.` }
  }

  const byRef = woken.filter(agent => agent.ref === lower)
  if (byRef.length === 1) return found(byRef[0])
  if (byRef.length > 1) {
    return {
      ok: false,
      error: `Ref "${key}" matches more than one agent: ${byRef.map(a => a.name).join(', ')}; use the full name.`
    }
  }

  const unwoken = agents.filter(agent => !agent.wakes)
  const listedUnwoken = unwoken.find(agent => agent.name.toLowerCase() === lower || agent.ref === lower)
  if (listedUnwoken) return { ok: false, error: cantReceive(listedUnwoken) }

  const address = recent.find(item => item.name.toLowerCase() === lower)
  if (address) return { ok: true, to: address, agent: null }

  // the reply a wake text asks for names the sender by its ref: a conversation no longer listed still answers to it
  const byRecent = recent.filter(item => refOf(item.session) === lower)
  if (byRecent.length === 1) return { ok: true, to: byRecent[0], agent: null }
  if (byRecent.length > 1) {
    return { ok: false, error: `Ref "${key}" matches more than one agent: ${byRecent.map(a => a.name).join(', ')}; use the full name.` }
  }
  return notFound
}

function found(agent: Agent): Resolved {
  return { ok: true, to: { device: agent.device, session: agent.session, name: agent.name }, agent }
}
