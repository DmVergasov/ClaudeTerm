import { describe, expect, it } from 'vitest'
import { isAbsPath, isAccountRef, isHash, isId, isIdList, isImageAction, isLineNo, isOptionalTitle, isPanelWidth, isPtyData, isPtySize, isFlag, isPromptInput, isReviewScope, isSessionId, isUserInput } from '../../src/main/ipc-guards'

describe('ipc guards', () => {
  it('isId accepts only strings', () => {
    expect(isId('abc')).toBe(true)
    expect(isId(1)).toBe(false)
    expect(isId(undefined)).toBe(false)
    expect(isId({})).toBe(false)
  })

  it('isAccountRef accepts null and a short non-empty id', () => {
    for (const v of [null, 'acc', 'x'.repeat(64)]) expect(isAccountRef(v)).toBe(true)
    for (const v of [undefined, '', 'x'.repeat(65), 1, {}]) expect(isAccountRef(v)).toBe(false)
  })

  it('isPtySize accepts integers in 1..4000 only', () => {
    expect(isPtySize(120, 30)).toBe(true)
    expect(isPtySize(4000, 4000)).toBe(true)
    expect(isPtySize(0, 30)).toBe(false)
    expect(isPtySize(120, -1)).toBe(false)
    expect(isPtySize(NaN, 30)).toBe(false)
    expect(isPtySize(1.5, 30)).toBe(false)
    expect(isPtySize(4001, 30)).toBe(false)
    expect(isPtySize('80', 30)).toBe(false)
    expect(isPtySize(Infinity, 30)).toBe(false)
  })

  it('isPanelWidth accepts finite px in 0..4000 only', () => {
    for (const v of [0, 320, 640.5, 4000]) expect(isPanelWidth(v)).toBe(true)
    for (const v of [-1, 4001, NaN, Infinity, '320', null, undefined]) expect(isPanelWidth(v)).toBe(false)
  })

  it('isUserInput ignores terminal-generated reports', () => {
    expect(isUserInput('a')).toBe(true)
    expect(isUserInput('\r')).toBe(true)
    expect(isUserInput('\x1b[A')).toBe(true)
    expect(isUserInput('\x1b[I')).toBe(false)
    expect(isUserInput('\x1b[O')).toBe(false)
    expect(isUserInput('\x1b[?1;2c')).toBe(false)
    expect(isUserInput('\x1b[12;40R')).toBe(false)
    expect(isUserInput('\x1b[I\x1b[O')).toBe(false)
    expect(isUserInput('\x1b[Ia')).toBe(true)
  })

  it('isPromptInput: keys that can put text in a prompt, not the mouse or the scroll keys', () => {
    for (const d of ['a', '\x7f', '\x15', '\x1b[A', '\x1b[B', '\x1b[200~text\x1b[201~', '\r']) expect(isPromptInput(d)).toBe(true)
    // SGR and X10 wheel and click reports, PgUp, PgDn, Home, End, Ctrl+Home, Ctrl+End, focus reports
    for (const d of ['\x1b[<65;40;12M', '\x1b[<64;40;12M\x1b[<64;40;12M', '\x1b[<0;10;5M\x1b[<0;10;5m', '\x1b[Ma!!', '\x1b[5~', '\x1b[6~', '\x1b[H', '\x1b[F', '\x1b[1~', '\x1b[4~', '\x1b[1;5H', '\x1b[1;5F', '\x1b[I']) {
      expect(isPromptInput(d)).toBe(false)
    }
    expect(isPromptInput('\x1b[<65;40;12Ma')).toBe(true)
  })

  it('isPtyData accepts only strings', () => {
    expect(isPtyData('x')).toBe(true)
    expect(isPtyData('')).toBe(true)
    expect(isPtyData(5)).toBe(false)
    expect(isPtyData(null)).toBe(false)
  })

  it('isIdList accepts arrays of strings', () => {
    expect(isIdList(['a', 'b'])).toBe(true)
    expect(isIdList(['a', 1])).toBe(false)
    expect(isIdList('a')).toBe(false)
  })

  it('isOptionalTitle accepts string or null', () => {
    expect(isOptionalTitle('t')).toBe(true)
    expect(isOptionalTitle(null)).toBe(true)
    expect(isOptionalTitle(undefined)).toBe(false)
    expect(isOptionalTitle(3)).toBe(false)
  })

  it('isImageAction accepts only known actions', () => {
    for (const a of ['open', 'reveal', 'copy-image', 'copy-path', 'remove']) expect(isImageAction(a)).toBe(true)
    expect(isImageAction('rm')).toBe(false)
    expect(isImageAction(undefined)).toBe(false)
    expect(isImageAction(1)).toBe(false)
  })
})

describe('review guards', () => {
  it('checks scopes, absolute paths, line numbers and hashes', () => {
    expect(isReviewScope('last_turn')).toBe(true)
    expect(isReviewScope('week')).toBe(false)
    expect(isAbsPath(process.platform === 'win32' ? 'D:\\p\\a.ts' : '/p/a.ts')).toBe(true)
    expect(isAbsPath('a.ts')).toBe(false)
    expect(isLineNo(1)).toBe(true)
    expect(isLineNo(0)).toBe(false)
    expect(isLineNo(1.5)).toBe(false)
    expect(isHash('0123456789abcdef0123456789abcdef01234567')).toBe(true)
    expect(isHash('x'.repeat(65))).toBe(false)
  })

  it('isSessionId accepts a session id (UUID) only', () => {
    expect(isSessionId('5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8')).toBe(true)
    expect(isSessionId('')).toBe(false)
    expect(isSessionId('../../etc/passwd')).toBe(false)
    expect(isSessionId('C:/Users/me/x.jsonl')).toBe(false)
    expect(isSessionId(7)).toBe(false)
    expect(isSessionId(null)).toBe(false)
    expect(isSessionId('5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'.repeat(20))).toBe(false)
  })

  it('isFlag accepts booleans only', () => {
    expect(isFlag(true)).toBe(true)
    expect(isFlag(false)).toBe(true)
    expect(isFlag('yes')).toBe(false)
    expect(isFlag(1)).toBe(false)
    expect(isFlag(undefined)).toBe(false)
  })
})
