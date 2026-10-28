import { describe, expect, it } from 'vitest'
import { promptText, type ScreenRow } from '../../src/renderer/claude-screen'

const RULE = '─'.repeat(80)
const blank = (s: string): string => ' '.repeat(s.length)
const row = (text: string, dim = ''): ScreenRow => ({ text: text + dim, bright: text + blank(dim), shaded: blank(text + dim) })
/** Claude Code puts a no-break space after the ❯ of its prompt; the user's prompts in the conversation above have a plain one */
const PROMPT = '❯\u00a0'
/** the bottom of Claude Code's fullscreen screen as it draws it: the prompt between two rules, then the status line */
const box = (...prompt: ScreenRow[]): ScreenRow[] => [row('● Done.'), row(''), row(RULE), ...prompt, row(RULE), row('  Opus 5.5  Effort: xhigh')]

describe('promptText', () => {
  it('is empty while the prompt shows only its dim placeholder', () => {
    expect(promptText(box(row(PROMPT, 'Try "fix lint errors"')))).toBe('')
  })

  it('is empty for an empty prompt whose no-break space was trimmed', () => {
    expect(promptText(box(row('❯')))).toBe('')
  })

  it('is the text typed into the prompt, on all its lines', () => {
    expect(promptText(box(row(PROMPT + 'half a question')))).toBe('half a question')
    expect(promptText(box(row(PROMPT + 'first'), row('  second')))).toBe('first\nsecond')
  })

  it('takes the prompt between the rules, not a prompt of the conversation above it', () => {
    expect(promptText([row('❯ fix the build'), ...box(row(PROMPT, 'Try "x"'))])).toBe('')
  })

  it('is null when the screen shows no prompt: a dialog in its place, or another program', () => {
    expect(promptText([row(' Do you want to proceed?'), row(' ❯ 1. Yes'), row('   2. No')])).toBeNull()
    expect(promptText([row('PS C:\\work> ')])).toBeNull()
    expect(promptText([])).toBeNull()
  })
})
