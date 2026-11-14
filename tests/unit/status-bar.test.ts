import { describe, expect, it } from 'vitest'
import { accountSegment, changesSegment, formatTokens, levelFor, limitPace, mcpSegment, modelFamily, planSegment, statusSegments } from '../../src/renderer/status-bar'
import type { McpReload, McpServerView, McpServersView, McpStatus } from '../../src/shared/mcp'
import type { AgentStatus, MainStatus, PlanStatus } from '../../src/shared/types'
import { taskListStatus } from '../../src/shared/task-list'

const H = 3_600_000
const FIVE_HOURS = 5 * H
/** the 5h window resets at 21:40; the status is read at 19:40, three hours into it */
const RESET = new Date(2026, 9, 5, 21, 40).getTime()
const NOW = RESET - 2 * H

const main: MainStatus = {
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  effort: 'xhigh',
  context: { usedTokens: 82_314, size: 200_000, usedPct: 41.2 },
  fiveHour: { usedPct: 23.5, resetsAt: RESET / 1000 },
  sevenDay: { usedPct: 41.2, resetsAt: new Date(2026, 9, 9, 14, 0).getTime() / 1000 }
}
const agent = (over: Partial<AgentStatus>): AgentStatus => ({ agentId: 'a', type: 'Explore', description: null, model: 'claude-opus-5-5', effort: 'high', startedAt: 0, ...over })

describe('statusSegments', () => {
  it('formats the four segments that are not limits: model, context, agents and background, and no segment is a limit', () => {
    const agents = [agent({ type: 'code-reviewer', description: 'Review font fix', startedAt: NOW - 3 * 60_000 - 5_000 })]
    const segments = statusSegments({ tabId: 't', main, agents, background: [] }, NOW)
    expect(segments).toEqual([
      { key: 'model', text: 'Opus 5.5', pill: 'xhigh', title: 'claude-opus-5-5', level: 'normal' },
      { key: 'context', text: 'ctx 41% · 82k/200k', title: '82,314 of 200,000 tokens', level: 'normal', fill: expect.closeTo(0.412, 10) },
      { key: 'agents', text: '⚙ 1: opus·high', title: 'code-reviewer · opus·high · 3 min · "Review font fix"', level: 'normal' }
    ])
    expect(segments.map((s) => s.key)).not.toContain('limit')
    expect(segments.map((s) => s.key)).not.toContain('week')
  })

  it('shows a context fill with no size as its share alone, which a chat knows without the token counts', () => {
    const fillOnly: MainStatus = { ...main, context: { usedTokens: 0, size: 0, usedPct: 42 } }
    const context = statusSegments({ tabId: 't', main: fillOnly, agents: [], background: [] }, NOW).find((s) => s.key === 'context')
    expect(context).toMatchObject({ text: 'ctx 42%', title: '42% of the context window used', level: 'normal', fill: 0.42 })
  })

  it('shows only the model early in a session', () => {
    const early: MainStatus = { model: { id: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' }, effort: null, context: null, fiveHour: null, sevenDay: null }
    expect(statusSegments({ tabId: 't', main: early, agents: [], background: [] }, 0)).toEqual([{ key: 'model', text: 'Haiku 4.5', title: 'claude-haiku-4-5-20251001', level: 'normal' }])
    expect(statusSegments({ tabId: 't', main: early, agents: [], background: [] }, 0)[0]).not.toHaveProperty('pill')
  })

  it('lists the background work still running after the turn: how many and what, and on hover each with its kind and command', () => {
    const background = [
      { id: 'b1', type: 'shell', description: 'build', command: 'npm run build' },
      { id: 'm1', type: 'monitor', description: null, command: 'tail -f server.log' },
      { id: 'a1', type: 'agent', description: null, command: null }
    ]
    expect(statusSegments({ tabId: 't', main, agents: [], background }, 0).at(-1)).toEqual({
      key: 'background',
      text: '3 in background: build, tail -f server.log, agent',
      title: 'Still running after the turn:\nshell · build · npm run build\nmonitor · tail -f server.log\nagent',
      level: 'normal'
    })
  })

  it('returns nothing without the main status', () => {
    expect(statusSegments({ tabId: 't', main: null, agents: [agent({})], background: [] }, 0)).toEqual([])
  })

  it('marks context warn from 70% and crit from 90%', () => {
    const at = (usedPct: number) => statusSegments({ tabId: 't', main: { ...main, context: { usedTokens: 1, size: 2, usedPct }, fiveHour: null, sevenDay: null }, agents: [], background: [] }, 0)
    expect(at(70).map((x) => x.level)).toEqual(['normal', 'warn'])
    expect(at(91).map((x) => x.level)).toEqual(['normal', 'crit'])
  })

  it('groups many agents by model·effort, most frequent first; unknown model shows …', () => {
    const agents = [
      agent({ agentId: '1', effort: 'xhigh' }),
      ...['2', '3', '4', '5', '6', '7'].map((id) => agent({ agentId: id, model: 'claude-sonnet-5-5', effort: 'medium' })),
      agent({ agentId: '8', effort: 'xhigh' }),
      agent({ agentId: '9', model: 'claude-haiku-4-5-20251001', effort: null }),
      agent({ agentId: '10', model: null, effort: null })
    ]
    expect(statusSegments({ tabId: 't', main, agents, background: [] }, 0).at(-1)?.text).toBe('⚙ 10: sonnet·medium ×6, opus·xhigh ×2, haiku, …')
  })

  it('agent tooltip: under a minute, no description', () => {
    expect(statusSegments({ tabId: 't', main, agents: [agent({ startedAt: 1000 })], background: [] }, 30_000).at(-1)?.title).toBe('Explore · opus·high · <1 min')
  })
})

describe('helpers', () => {
  it('levelFor', () => {
    expect([69.9, 70, 89.9, 90].map(levelFor)).toEqual(['normal', 'warn', 'warn', 'crit'])
  })

  it('formatTokens', () => {
    expect([999, 1000, 82_314, 200_000, 999_499, 999_500, 1_000_000, 1_500_000].map(formatTokens)).toEqual(['999', '1k', '82k', '200k', '999k', '1M', '1M', '1.5M'])
  })

  it('modelFamily', () => {
    expect(['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'gpt-x'].map(modelFamily)).toEqual(['opus', 'haiku', 'gpt-x'])
  })
})

describe('changesSegment', () => {
  it('counts the files and lines in parts the bar colors, with a file icon, and names the scope in the title', () => {
    expect(changesSegment({ files: 3, additions: 40, deletions: 12, title: 'Uncommitted changes in D:\\repo' })).toEqual({
      key: 'changes', text: '3 files +40 −12', title: 'Uncommitted changes in D:\\repo', level: 'normal',
      icon: 'file-diff', diff: { files: '3 files', added: '+40', removed: '−12' }
    })
    expect(changesSegment({ files: 1, additions: 1, deletions: 0, title: 't' }).text).toBe('1 file +1 −0')
  })
})

describe('mcpSegment', () => {
  const server = (name: string, status: McpStatus, tools: string[] = []): McpServerView =>
    ({ name, status, scope: 'user', plugin: null, transport: 'stdio', target: `npx ${name}`, tools, error: null, version: null })
  const view = (servers: McpServerView[], reload: McpReload | null = null, live = true): McpServersView => ({ live, servers, reload })

  it('counts the connected servers quietly, with a plug, and lists every server on hover with what a click does', () => {
    expect(mcpSegment(view([server('github', 'connected', ['a', 'b']), server('context7', 'connected', ['c']), server('memory', 'disabled')]))).toEqual({
      key: 'mcp', text: 'MCP 2', level: 'normal', icon: 'plug',
      title: 'context7: 1 tool\ngithub: 2 tools\nmemory: Disabled\nClick for MCP servers and plugins'
    })
  })

  it('a server that failed turns it red: the connected out of the servers on, and how many failed', () => {
    expect(mcpSegment(view([server('github', 'connected'), server('linear', 'failed'), server('sentry', 'needs-auth'), server('memory', 'disabled')]))).toMatchObject({
      text: 'MCP 1/3 · 1 failed', level: 'crit'
    })
  })

  it('a server waiting for its sign-in or its approval turns it amber and says what it waits for', () => {
    expect(mcpSegment(view([server('github', 'connected'), server('sentry', 'needs-auth'), server('linear', 'needs-auth')]))).toMatchObject({ text: 'MCP · sign in to 2', level: 'warn' })
    expect(mcpSegment(view([server('github', 'connected'), server('postgres', 'pending-approval')]))).toMatchObject({ text: 'MCP · approve 1', level: 'warn' })
  })

  it('changes the session has not loaded turn it blue: a restart loads or drops them, and the hover says so', () => {
    const added = mcpSegment(view([server('github', 'connected')], { changes: 2, verb: 'load' }))
    expect(added).toMatchObject({ text: 'MCP · restart to load 2', level: 'info' })
    expect(added.title).toBe('github: 0 tools\nRestart the session to load 2 changes\nClick for MCP servers and plugins')
    expect(mcpSegment(view([], { changes: 1, verb: 'drop' }))).toMatchObject({ text: 'MCP · restart to drop 1', level: 'info' })
  })

  it('with no session running it counts the servers configured and on; with none it says MCP alone', () => {
    expect(mcpSegment(view([server('github', 'configured'), server('notes', 'configured'), server('memory', 'disabled')], null, false))).toMatchObject({
      text: 'MCP 2', level: 'normal', title: 'github: configured\nmemory: Disabled\nnotes: configured\nClick for MCP servers and plugins'
    })
    expect(mcpSegment(view([]))).toMatchObject({ text: 'MCP', level: 'normal', title: 'No MCP servers\nClick for MCP servers and plugins' })
  })
})

describe('accountSegment', () => {
  it('names the tab\'s account and says a click switches it', () => {
    expect(accountSegment('Work')).toEqual({ key: 'account', text: 'Work', title: 'The account this tab runs on — click to switch', level: 'normal' })
  })
})

const plan = (done: number, finished = false, current = 'Save dialog and file writing'): PlanStatus => ({
  title: 'CSV Export', done, total: 7, finished,
  tasks: Array.from({ length: 7 }, (_, i) => ({ n: i + 1, title: i === done ? current : `T${i + 1}`, state: finished || i < done ? 'done' : i === done ? 'current' : 'left' }))
})
it('planSegment: done/total and the current task; ✓ when finished; Task N for an untitled task', () => {
  expect(planSegment(plan(3))).toEqual({ key: 'plan', text: '3/7 · Save dialog and file writing', title: 'CSV Export — 3 of 7 done. Click for the task list', level: 'normal', fill: 3 / 7 })
  expect(planSegment(plan(7, true))).toMatchObject({ text: '✓ 7/7', fill: 1 })
  expect(planSegment(plan(3, false, '')).text).toBe('3/7 · Task 4')
})
it('planSegment: a list with no task in progress shows its count alone; ✓ only when every task is done', () => {
  expect(planSegment(taskListStatus({ title: 'Release prep', tasks: [{ title: 'A', status: 'pending' }, { title: 'B', status: 'pending' }, { title: 'C', status: 'pending' }] })).text).toBe('0/3')
  expect(planSegment(taskListStatus({ title: 'Release prep', tasks: [{ title: 'A', status: 'completed' }, { title: 'B', status: 'pending' }, { title: 'C', status: 'pending' }] })).text).toBe('1/3')
  expect(planSegment(taskListStatus({ title: 'Release prep', tasks: [{ title: 'A', status: 'completed' }, { title: 'B', status: 'completed' }, { title: 'C', status: 'completed' }] })).text).toBe('✓ 3/3')
})

describe('limitPace', () => {
  /** the 5h window, read `elapsedH` hours into it, with `used` % spent */
  const pace = (used: number, elapsedH: number) => limitPace(used, RESET / 1000, FIVE_HOURS, RESET - FIVE_HOURS + elapsedH * H)

  it('a limit that lasts until the reset at the pace so far is normal, and says how much it reaches by then', () => {
    expect(pace(30, 2)).toEqual({ elapsed: 0.4, runsOutAt: null, atReset: 75, level: 'normal' })
  })

  it('one that would run out in the second half of the time left warns, and says when it runs out', () => {
    // 85% in 4 hours: the last 15% go in 42 of the 60 minutes left
    const p = pace(85, 4)
    expect(p.level).toBe('warn')
    expect(p.runsOutAt! - (RESET - H)).toBeCloseTo((15 / 85) * 4 * H, -3)
  })

  it('one that would run out in the first half of the time left is crit', () => {
    expect(pace(50, 1)).toMatchObject({ runsOutAt: RESET - 3 * H, level: 'crit' })
  })

  it('90% used warns even when the rest lasts until the reset', () => {
    expect(pace(92, 4.8)).toMatchObject({ runsOutAt: null, level: 'warn' })
  })

  it('a limit used up is crit', () => {
    expect(pace(100, 3)).toEqual({ elapsed: 0.6, runsOutAt: null, atReset: null, level: 'crit' })
  })

  it('in the first 8% of the window, and with the reset time passed, the fixed 70% and 90% apply', () => {
    // 75% in the first 18 minutes would run out at once: too early to tell
    expect(pace(75, 0.3)).toEqual({ elapsed: 0.06, runsOutAt: null, atReset: null, level: 'warn' })
    expect(pace(95, 0.3).level).toBe('crit')
    expect(limitPace(75, RESET / 1000, FIVE_HOURS, RESET + 1000)).toEqual({ elapsed: 1, runsOutAt: null, atReset: null, level: 'warn' })
  })
})
