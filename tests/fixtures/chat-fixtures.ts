import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The recorded protocol fixtures (tests/fixtures/chat/README.md) with their placeholders filled in

export interface FixtureVars { cwd?: string; home?: string; settings?: string }

const FOLDER = resolve(import.meta.dirname, 'chat')

/** a value as it sits inside a JSON string of the fixture text */
const escaped = (s: string): string => JSON.stringify(s).slice(1, -1)

function fill(text: string, vars: FixtureVars = {}): string {
  return text
    .split('{{CWD}}').join(escaped(vars.cwd ?? '/work/acme'))
    .split('{{HOME}}').join(escaped(vars.home ?? '/home/user'))
    .split('{{SETTINGS}}').join(escaped(vars.settings ?? '/tmp/settings.json'))
}

/** the messages of one direction of `<name>.jsonl`, in order: `in` what the SDK wrote, `out` what Claude Code wrote */
export function fixtureLines(name: string, dir: 'in' | 'out', vars?: FixtureVars): unknown[] {
  const text = readFileSync(resolve(FOLDER, `${name}.jsonl`), 'utf8')
  return text.split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(fill(line, vars)) as { dir: string; line: unknown })
    .filter(entry => entry.dir === dir)
    .map(entry => entry.line)
}

/** the session history of `history.json`: the messages as getSessionMessages returned them */
export function fixtureHistory(vars?: FixtureVars): unknown[] {
  return JSON.parse(fill(readFileSync(resolve(FOLDER, 'history.json'), 'utf8'), vars)) as unknown[]
}
