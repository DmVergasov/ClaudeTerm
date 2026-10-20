import { describe, expect, it } from 'vitest'
import { PlanWorkspaceFinder } from '../../src/main/transcript-plan'
import { bashResultLine, toolUseLine } from '../fixtures/transcript'

const WS = '/w/acme-shop/.superpowers/sdd/2026-10-20-csv-export'
const RUN = 'cd /w/acme-shop && bash /p/skills/subagent-driven-development/scripts/sdd-workspace docs/superpowers/plans/2026-10-20-csv-export.md; ls /p/skills/subagent-driven-development'

describe('PlanWorkspaceFinder', () => {
  it('the workspace path an sdd-workspace run printed, among the other output of the command', () => {
    const f = new PlanWorkspaceFinder()
    expect(f.parseLine(toolUseLine('toolu_1', 'Skill', { skill: 'superpowers:subagent-driven-development' }))).toBeNull()
    expect(f.parseLine(toolUseLine('toolu_2', 'Bash', { command: RUN }))).toBeNull()
    expect(f.parseLine(bashResultLine('toolu_2', `${WS}\nSKILL.md\nimplementer-prompt.md\nscripts/\n`))?.printed).toBe(WS)
  })
  it('MSYS and Windows paths come back as printed; text blocks are read too', () => {
    const f = new PlanWorkspaceFinder()
    f.parseLine(toolUseLine('a', 'Bash', { command: RUN }))
    expect(f.parseLine(bashResultLine('a', '/d/Work/acme-shop/.superpowers/sdd/x\r\n'))?.printed).toBe('/d/Work/acme-shop/.superpowers/sdd/x')
    f.parseLine(toolUseLine('b', 'Bash', { command: RUN }))
    const blocks = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'C:\\Work\\a\\.superpowers\\sdd\\y' }] }] } })
    expect(f.parseLine(blocks)?.printed).toBe('C:\\Work\\a\\.superpowers\\sdd\\y')
  })
  it('results of other Bash calls are ignored, even when they list workspaces', () => {
    const f = new PlanWorkspaceFinder()
    f.parseLine(toolUseLine('c', 'Bash', { command: 'ls -d /w/acme-shop/.superpowers/sdd/*' }))
    expect(f.parseLine(bashResultLine('c', `${WS}\n/w/acme-shop/.superpowers/sdd/2026-09-01-old\n`))).toBeNull()
  })
  it('a run that printed no workspace gives nothing and is forgotten; malformed lines give nothing', () => {
    const f = new PlanWorkspaceFinder()
    f.parseLine(toolUseLine('d', 'Bash', { command: RUN }))
    expect(f.parseLine(bashResultLine('d', 'no such plan file: docs/x.md\n'))).toBeNull()
    expect(f.parseLine(bashResultLine('d', `${WS}\n`))).toBeNull()
    expect(f.parseLine('{"type":"user","message":')).toBeNull()
  })
  it('a path printed with a prefix, in quotes or with a trailing slash is found', () => {
    const f = new PlanWorkspaceFinder()
    const run = (id: string, out: string) => {
      f.parseLine(toolUseLine(id, 'Bash', { command: RUN }))
      return f.parseLine(bashResultLine(id, out))?.printed
    }
    expect(run('p1', `WS=${WS}\nSKILL.md\n`)).toBe(WS)
    expect(run('p2', `W=${WS}\n`)).toBe(WS)
    expect(run('p3', `WS="${WS}"\n`)).toBe(WS)
    expect(run('p4', `${WS}/\n`)).toBe(WS)
    expect(run('p5', 'WS=C:\\Work\\a\\.superpowers\\sdd\\y\n')).toBe('C:\\Work\\a\\.superpowers\\sdd\\y')
    expect(run('p6', 'WS=D:/Work/a/.superpowers/sdd/y\n')).toBe('D:/Work/a/.superpowers/sdd/y')
  })
  it('a path with spaces is found whole: bare, after a prefix or in quotes', () => {
    const f = new PlanWorkspaceFinder()
    const run = (id: string, out: string) => {
      f.parseLine(toolUseLine(id, 'Bash', { command: RUN }))
      return f.parseLine(bashResultLine(id, out))?.printed
    }
    const SP = '/c/Users/Jane Doe/acme-shop/.superpowers/sdd/2026-10-20-csv-export'
    expect(run('s1', `${SP}\nSKILL.md\n`)).toBe(SP)
    expect(run('s2', `WS=${SP}\n`)).toBe(SP)
    expect(run('s3', `WS="${SP}/"\n`)).toBe(SP)
    expect(run('s4', 'C:\\Users\\Jane Doe\\acme-shop\\.superpowers\\sdd\\y\n')).toBe('C:\\Users\\Jane Doe\\acme-shop\\.superpowers\\sdd\\y')
  })
  it('a line that merely mentions a path in the middle gives nothing', () => {
    const f = new PlanWorkspaceFinder()
    f.parseLine(toolUseLine('q', 'Bash', { command: RUN }))
    expect(f.parseLine(bashResultLine('q', `ls: cannot access '${WS}/progress.md': No such file\n`))).toBeNull()
  })
  it('the time of the result entry comes with the path; 0 when it has none', () => {
    const f = new PlanWorkspaceFinder()
    f.parseLine(toolUseLine('r', 'Bash', { command: RUN }))
    expect(f.parseLine(bashResultLine('r', `${WS}\n`, '2026-10-05T10:00:01.000Z'))).toEqual({ printed: WS, at: Date.parse('2026-10-05T10:00:01.000Z') })
    f.parseLine(toolUseLine('s', 'Bash', { command: RUN }))
    const o = JSON.parse(bashResultLine('s', `${WS}\n`))
    delete o.timestamp
    expect(f.parseLine(JSON.stringify(o))).toEqual({ printed: WS, at: 0 })
  })
})
