import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUpdateNotes } from '../../src/main/update-notes'

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'release-notes.mjs')
const run = (...args: string[]): string => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

describe('scripts/release-notes.mjs', () => {
  it('gives the GitHub release its version\'s section of CHANGELOG.md, without the heading', () => {
    const out = run('0.3.0')
    expect(out.startsWith('### New')).toBe(true)
    expect(out.split(/\r?\n/).filter((l) => l.startsWith('## '))).toEqual([])
  })

  it('--updater gives the update feed the version\'s section and the nine before it, with headings the app reads', () => {
    const out = run('--updater', '0.3.1')
    expect(out.split(/\r?\n/).filter((l) => l.startsWith('## '))).toEqual(
      ['## 0.3.1', '## 0.3.0', '## 0.2.0', '## 0.1.9', '## 0.1.8', '## 0.1.7', '## 0.1.6', '## 0.1.5', '## 0.1.4', '## 0.1.3']
    )
    const notes = parseUpdateNotes(out, '0.2.0', '0.3.1')
    expect(notes.map((n) => n.version)).toEqual(['0.3.1', '0.3.0'])
    expect(notes[1]!.items.map((i) => i.title)).toEqual([
      'Find in the Changes panel',
      'Hide test files',
      'Star your important sessions',
      "Show in Explorer in a changed file's ⋯ menu opens its folder with the file selected"
    ])
  })

  it('fails when the version has no section, in both modes', () => {
    expect(() => run('9.9.9')).toThrow()
    expect(() => run('--updater', '9.9.9')).toThrow()
  })
})
