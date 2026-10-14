import { describe, expect, it } from 'vitest'
import { parseUpdateNotes } from '../../src/main/update-notes'

const NOTES = [
  '## 0.4.1',
  '',
  '### Fixes',
  '',
  '- **Tabs keep their names after a restart.** A renamed tab came back with the folder name.',
  '',
  '## 0.4.0',
  '',
  '### New',
  '',
  '- **Find in the Changes panel.** Click into the diff and press `Ctrl+F`.',
  '- **Hide files git ignores** (on by default, in **Settings → Review**): Last turn and Session leave out build output.',
  '- Right-click a line to open the file at that line in your editor: VS Code by default.',
  '- A terminal bell from any program can now flash the taskbar',
  '  and mark its tab.',
  '',
  '### Fixes',
  '',
  "- **Show in Explorer** in a changed file's menu opens its folder. See the [README](https://example.com/readme) for more.",
  '',
  '## 0.3.1',
  '',
  '- Already installed.'
].join('\n')

const versions = (notes: unknown, current: string, latest: string): string[] => parseUpdateNotes(notes, current, latest).map((n) => n.version)

describe('parseUpdateNotes', () => {
  it('lists the versions newer than the installed one, up to the downloaded one, newest first', () => {
    expect(versions(NOTES, '0.3.1', '0.4.1')).toEqual(['0.4.1', '0.4.0'])
    expect(versions(NOTES, '0.4.0', '0.4.1')).toEqual(['0.4.1'])
    expect(versions(NOTES, '0.3.1', '0.4.0')).toEqual(['0.4.0'])
    expect(versions(NOTES.replaceAll('\n', '\r\n'), '0.3.1', '0.4.1')).toEqual(['0.4.1', '0.4.0'])
  })

  it('compares versions number by number', () => {
    const notes = '## 0.10.0\n\n- Ten.\n\n## 0.9.0\n\n- Nine.\n'
    expect(versions(notes, '0.9.0', '0.10.0')).toEqual(['0.10.0'])
  })

  it('takes the headline of each item: its first sentence, or what comes before a colon, without markdown', () => {
    const [v040] = parseUpdateNotes(NOTES, '0.3.1', '0.4.0')
    expect(v040!.items.map((i) => i.title)).toEqual([
      'Find in the Changes panel',
      'Hide files git ignores (on by default, in Settings → Review)',
      'Right-click a line to open the file at that line in your editor',
      'A terminal bell from any program can now flash the taskbar and mark its tab',
      "Show in Explorer in a changed file's menu opens its folder"
    ])
  })

  it('keeps the whole item, without markdown, for the tooltip', () => {
    const [v040] = parseUpdateNotes(NOTES, '0.3.1', '0.4.0')
    expect(v040!.items[0]!.text).toBe('Find in the Changes panel. Click into the diff and press Ctrl+F.')
    expect(v040!.items[4]!.text).toBe("Show in Explorer in a changed file's menu opens its folder. See the README for more.")
  })

  it('cuts a long headline', () => {
    const [n] = parseUpdateNotes(`## 1.0.0\n\n- ${'word '.repeat(60)}\n`, '0.9.0', '1.0.0')
    const title = n!.items[0]!.title
    expect(title.length).toBeLessThanOrEqual(120)
    expect(title.endsWith('…')).toBe(true)
  })

  it('gives no notes for what it cannot read: not a string, the HTML of the release feed, no version headings', () => {
    expect(parseUpdateNotes(null, '0.3.1', '0.4.0')).toEqual([])
    expect(parseUpdateNotes([{ version: '0.4.0', note: 'x' }], '0.3.1', '0.4.0')).toEqual([])
    expect(parseUpdateNotes('<h3>New</h3><ul><li><strong>Find in the Changes panel.</strong> Click</li></ul>', '0.3.1', '0.4.0')).toEqual([])
    expect(parseUpdateNotes('- **Find in the Changes panel.** Click into the diff.', '0.3.1', '0.4.0')).toEqual([])
  })

  it('leaves out a version without items and keeps within limits', () => {
    expect(versions('## 0.4.0\n\n### New\n\n## 0.3.2\n\n- Fix.\n', '0.3.1', '0.4.0')).toEqual(['0.3.2'])
    const many = Array.from({ length: 30 }, (_, i) => `## 1.${30 - i}.0\n\n${Array.from({ length: 50 }, (_, j) => `- Item ${j}.`).join('\n')}\n`).join('\n')
    const notes = parseUpdateNotes(many, '0.1.0', '1.30.0')
    expect(notes).toHaveLength(10)
    expect(notes[0]!.version).toBe('1.30.0')
    expect(notes.every((n) => n.items.length === 20)).toBe(true)
  })
})
