import { describe, expect, it } from 'vitest'
import type { ScreenRow } from '../../src/renderer/claude-screen'
import { leftUnfinished } from '../../src/renderer/unread'

const RULE = '─'.repeat(80)
const blank = (s: string): string => ' '.repeat(s.length)
const row = (text: string, dim = ''): ScreenRow => ({ text: text + dim, bright: text + blank(dim), shaded: blank(text + dim) })
/** a conversation row with Claude Code's pill drawn over it on a background of its own, as its fullscreen mode does */
const pillOver = (before: string, pill: string, after = ''): ScreenRow =>
  ({ text: before + pill + after, bright: before + pill + after, shaded: blank(before) + pill + blank(after) })
/** Claude Code puts a no-break space after the ❯ of its prompt; the user's prompts in the conversation above have a plain one */
const PROMPT = '❯\u00a0'
/** the bottom of Claude Code's fullscreen screen as it draws it: the prompt between two rules, then the status line */
const box = (...prompt: ScreenRow[]): ScreenRow[] => [row(''), row(RULE), ...prompt, row(RULE), row('  Opus 5.5  Effort: xhigh')]
const screen = (rows: ScreenRow[], scrolledBack = false) => ({ rows, scrolledBack })

describe('leftUnfinished', () => {
  it('an empty prompt shows its placeholder dim: nothing is left', () => {
    expect(leftUnfinished(screen(box(row(PROMPT, 'Try "fix lint errors"'))))).toBe(false)
  })

  it('text in the prompt is an unsent draft', () => {
    expect(leftUnfinished(screen(box(row(PROMPT + 'hello draft'))))).toBe(true)
  })

  it('a draft on a later line of the prompt counts too', () => {
    expect(leftUnfinished(screen(box(row(PROMPT), row('  second line'))))).toBe(true)
  })

  it('a prompt line in the conversation above is not the prompt', () => {
    expect(leftUnfinished(screen([row('❯ fix the build'), row('● Done.'), ...box(row(PROMPT, 'Try "fix lint errors"'))]))).toBe(false)
  })

  it('Claude Code\'s pill of a conversation scrolled up: Jump to bottom, or the count of new messages', () => {
    const empty = box(row(PROMPT, 'Try "fix lint errors"'))
    const over = (pill: string): boolean => leftUnfinished(screen([pillOver('  Ran 4 shell commands     ', pill, ' more text'), ...empty]))
    expect(over(' Jump to bottom (ctrl+End) ↓ ')).toBe(true)
    expect(over(' 3 new messages (ctrl+End) ↓ ')).toBe(true)
    expect(over(' 1 new message (click) ↓ ')).toBe(true)
    expect(over(' Jump to bottom: fn+↓ to scroll ')).toBe(true)
    expect(over(' Jump to bottom ↓ ')).toBe(true)
  })

  it('the pill\'s words in the conversation itself are not the pill: they have no background of their own', () => {
    const empty = box(row(PROMPT, 'Try "x"'))
    expect(leftUnfinished(screen([row('● the hint says Jump to bottom when you scroll'), ...empty]))).toBe(false)
    expect(leftUnfinished(screen([row('  07:02:19 shows `Jump to bottom (ctrl+End) ↓` on screen'), ...empty]))).toBe(false)
  })

  it('a terminal scrolled back in its scrollback is left mid-reply', () => {
    expect(leftUnfinished(screen(box(row(PROMPT, 'Try "x"')), true))).toBe(true)
  })

  it('a screen without the prompt (a dialog is open) and without the pill leaves nothing', () => {
    expect(leftUnfinished(screen([row(' Do you want to proceed?'), row(' ❯ 1. Yes'), row('   2. No')]))).toBe(false)
    expect(leftUnfinished(screen([]))).toBe(false)
  })
})
