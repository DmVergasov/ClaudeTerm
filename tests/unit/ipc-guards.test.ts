import { describe, expect, it } from 'vitest'
import { MAX_ADDRESS_LENGTH } from '../../src/shared/devices'
import { MAX_NOTE_LENGTH } from '../../src/shared/note'
import type { OpenTabRequest } from '../../src/shared/types'
import { MAX_PATH_TEXT, MAX_SNAPSHOT_BYTES, MAX_TRANSFER_FILES } from '../../src/shared/remote'
import { isAbsPath, isAccountRef, isDropPaths, isAddressInput, isDeviceId, isDeviceNameInput, isDocAction, isFolderInput, isGeneration, isTabCount, isHash, isId, isIdList, isImageAction, isLineNo, isLineSpan, isNoteForm, isNoteSide, isNoteSizeArg, isNoteText, isOpenRemoteTabArgs, isProjectKeyArg, isOpenTabRequest, openTabRequestFields, isOptionalAddress, isOptionalTitle, isPairCodeInput, isPanelWidth, isPathText, isPtyData, isPtySize, isFlag, isPromptInput, isReviewScope, isSeedText, isSeedToken, isSessionId, isTabLayoutChange, isUserInput } from '../../src/main/ipc-guards'

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
  it('isDropPaths takes 1 to MAX_TRANSFER_FILES absolute paths of this device', () => {
    const ABS = process.platform === 'win32' ? 'D:\\p\\a.png' : '/p/a.png'
    expect(isDropPaths([ABS])).toBe(true)
    expect(isDropPaths([])).toBe(false)
    expect(isDropPaths(Array(MAX_TRANSFER_FILES + 1).fill(ABS))).toBe(false)
    expect(isDropPaths(Array(MAX_TRANSFER_FILES).fill(ABS))).toBe(true)
    expect(isDropPaths(['relative'])).toBe(false)
    expect(isDropPaths([ABS, 3])).toBe(false)
    expect(isDropPaths(ABS)).toBe(false)
    expect(isDropPaths([ABS + 'x'.repeat(MAX_PATH_TEXT)])).toBe(false)
  })
  it('checks scopes, absolute paths, line numbers and hashes', () => {
    expect(isReviewScope('last_turn')).toBe(true)
    expect(isReviewScope('week')).toBe(false)
    expect(isAbsPath(process.platform === 'win32' ? 'D:\\p\\a.ts' : '/p/a.ts')).toBe(true)
    expect(isAbsPath('a.ts')).toBe(false)
    expect(isLineNo(1)).toBe(true)
    expect(isLineNo(0)).toBe(false)
    expect(isLineNo(1.5)).toBe(false)
    expect(isHash('0123456789abcdef0123456789abcdef01234567')).toBe(true)
    expect(isHash('binary:' + 'f'.repeat(64))).toBe(true)
    expect(isHash('x'.repeat(129))).toBe(false)
  })

  it('isLineSpan takes the lines of one expand click: whole numbers from 1, in order, at most 1000 of them', () => {
    expect(isLineSpan(1, 20)).toBe(true)
    expect(isLineSpan(5, 5)).toBe(true)
    expect(isLineSpan(1, 1000)).toBe(true)
    expect(isLineSpan(0, 5)).toBe(false)
    expect(isLineSpan(6, 5)).toBe(false)
    expect(isLineSpan(1.5, 5)).toBe(false)
    expect(isLineSpan(1, 1001)).toBe(false)
    expect(isLineSpan('1', 5)).toBe(false)
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

  it('isTabLayoutChange checks the width and the folded groups when present', () => {
    for (const v of [{}, { width: 300 }, { folded: ['k'] }, { width: 300, folded: [] }, { width: 0 }, { width: 9000 }, { folded: ['x'.repeat(4096)] }, { folded: Array.from({ length: 200 }, (_, i) => String(i)) }]) expect(isTabLayoutChange(v)).toBe(true)
    for (const v of [null, undefined, 'x', { width: NaN }, { width: Infinity }, { width: '300' }, { folded: 'k' }, { folded: [1] }, { folded: ['x'.repeat(4097)] }, { folded: Array.from({ length: 201 }, () => 'k') }]) expect(isTabLayoutChange(v)).toBe(false)
  })

  it('isFlag accepts booleans only', () => {
    expect(isFlag(true)).toBe(true)
    expect(isFlag(false)).toBe(true)
    expect(isFlag('yes')).toBe(false)
    expect(isFlag(1)).toBe(false)
    expect(isFlag(undefined)).toBe(false)
  })

  it('isNoteText accepts strings up to MAX_NOTE_LENGTH', () => {
    expect(isNoteText('')).toBe(true)
    expect(isNoteText('x'.repeat(MAX_NOTE_LENGTH))).toBe(true)
    expect(isNoteText('x'.repeat(MAX_NOTE_LENGTH + 1))).toBe(false)
    expect(isNoteText(5)).toBe(false)
  })

  it('isNoteForm accepts label and card only', () => {
    expect(isNoteForm('label')).toBe(true)
    expect(isNoteForm('card')).toBe(true)
    expect(isNoteForm('hidden')).toBe(false)
    expect(isNoteForm(null)).toBe(false)
  })

  it('isNoteSide takes session and project only', () => {
    expect(isNoteSide('session')).toBe(true)
    expect(isNoteSide('project')).toBe(true)
    expect(isNoteSide('left')).toBe(false)
    expect(isNoteSide('')).toBe(false)
    expect(isNoteSide(null)).toBe(false)
  })

  it('isNoteSizeArg takes a size within the bounds, or null', () => {
    expect(isNoteSizeArg(null)).toBe(true)
    expect(isNoteSizeArg({ width: 340, height: 240 })).toBe(true)
    expect(isNoteSizeArg(undefined)).toBe(false)
    expect(isNoteSizeArg({ width: 10, height: 10 })).toBe(false)
    expect(isNoteSizeArg({ width: 340 })).toBe(false)
  })

  it('isProjectKeyArg takes a project key', () => {
    expect(isProjectKeyArg('c:\\work\\acme')).toBe(true)
    expect(isProjectKeyArg('')).toBe(false)
    expect(isProjectKeyArg('a\0b')).toBe(false)
  })

  it('isTabCount accepts a whole number of tabs from 0 to 10000', () => {
    expect(isTabCount(0)).toBe(true)
    expect(isTabCount(3)).toBe(true)
    expect(isTabCount(10_000)).toBe(true)
    expect(isTabCount(10_001)).toBe(false)
    expect(isTabCount(-1)).toBe(false)
    expect(isTabCount(1.5)).toBe(false)
    expect(isTabCount(Number.NaN)).toBe(false)
    expect(isTabCount('2')).toBe(false)
  })

  it('isGeneration accepts a whole number from 0 on', () => {
    expect(isGeneration(0)).toBe(true)
    expect(isGeneration(7)).toBe(true)
    expect(isGeneration(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(isGeneration(-1)).toBe(false)
    expect(isGeneration(1.5)).toBe(false)
    expect(isGeneration(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
    expect(isGeneration(Number.NaN)).toBe(false)
    expect(isGeneration(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isGeneration('1')).toBe(false)
    expect(isGeneration(undefined)).toBe(false)
  })

  it('isDocAction accepts the document panel actions only', () => {
    for (const v of ['open', 'reveal', 'copy-path', 'remove']) expect(isDocAction(v)).toBe(true)
    for (const v of ['copy-image', '', 1, null]) expect(isDocAction(v)).toBe(false)
  })
})

/** an absolute folder on this system: the guard checks what path.isAbsolute says */
const FOLDER = process.platform === 'win32' ? 'C:/Work/acme' : '/work/acme'

describe('open tab request guard', () => {
  const SESSION = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

  it('isOpenTabRequest accepts a shell or Claude tab with a folder, and the optional fields when they are of their type', () => {
    expect(isOpenTabRequest({ kind: 'shell', cwd: FOLDER })).toBe(true)
    expect(isOpenTabRequest({ kind: 'claude', cwd: FOLDER, profile: 'work', title: 'Shop', resumeSessionId: SESSION, account: 'acc', muted: true })).toBe(true)
    expect(isOpenTabRequest({ kind: 'claude', cwd: FOLDER, profile: null, title: null, resumeSessionId: null, account: null })).toBe(true)
  })

  it('isOpenTabRequest rejects another kind, a missing or empty folder, and a field of the wrong type', () => {
    const bad: unknown[] = [
      null, FOLDER, {}, { kind: 'fork', cwd: FOLDER }, { kind: 'shell' }, { kind: 'shell', cwd: '' },
      { kind: 'shell', cwd: FOLDER, profile: 1 }, { kind: 'shell', cwd: FOLDER, title: 1 },
      { kind: 'claude', cwd: FOLDER, resumeSessionId: 'not-a-session' }, { kind: 'claude', cwd: FOLDER, account: '' },
      { kind: 'shell', cwd: FOLDER, muted: 'yes' }
    ]
    for (const v of bad) expect(isOpenTabRequest(v)).toBe(false)
  })
})

describe('open tab request fields', () => {
  it('a relative folder is not an open tab request', () => {
    expect(isOpenTabRequest({ kind: 'shell', cwd: 'Work/acme' })).toBe(false)
    expect(isOpenTabRequest({ kind: 'shell', cwd: FOLDER })).toBe(true)
  })

  it('openTabRequestFields keeps the checked fields only: a renderer cannot pass setupToken or strict into a launch', () => {
    const sent = { kind: 'shell', cwd: FOLDER, setupToken: true, strict: true, fork: { of: 'x', from: 'y' } } as unknown as OpenTabRequest
    const picked = openTabRequestFields(sent)
    expect(picked).toEqual({ kind: 'shell', cwd: FOLDER, fork: null })
    expect(picked).not.toHaveProperty('setupToken')
    expect(picked).not.toHaveProperty('strict')
  })

  it('openTabRequestFields keeps the optional fields that were sent', () => {
    const sent: OpenTabRequest = { kind: 'claude', cwd: FOLDER, profile: 'work', title: 'Shop', resumeSessionId: '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8', account: 'acc', muted: true }
    expect(openTabRequestFields(sent)).toEqual({ ...sent, fork: null })
  })
})

describe('device guards', () => {
  it('isDeviceId accepts a device id (UUID) only', () => {
    expect(isDeviceId('5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8')).toBe(true)
    expect(isDeviceId('macbook')).toBe(false)
    expect(isDeviceId(null)).toBe(false)
  })

  it('isOpenRemoteTabArgs accepts a device id, a claude or shell kind, a profile name or null, and an account ref or null', () => {
    const device = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
    expect(isOpenRemoteTabArgs(device, 'claude', null, null)).toBe(true)
    expect(isOpenRemoteTabArgs(device, 'shell', 'Bash', 'w')).toBe(true)
    expect(isOpenRemoteTabArgs(device, 'shell', 'x'.repeat(256), null)).toBe(true)
  })

  it('isOpenRemoteTabArgs refuses anything else', () => {
    const device = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
    expect(isOpenRemoteTabArgs('x', 'claude', null, null)).toBe(false)
    expect(isOpenRemoteTabArgs(null, 'claude', null, null)).toBe(false)
    expect(isOpenRemoteTabArgs(device, 'other', null, null)).toBe(false)
    expect(isOpenRemoteTabArgs(device, undefined, null, null)).toBe(false)
    expect(isOpenRemoteTabArgs(device, 'shell', '', null)).toBe(false)
    expect(isOpenRemoteTabArgs(device, 'shell', 'x'.repeat(257), null)).toBe(false)
    expect(isOpenRemoteTabArgs(device, 'shell', 42, null)).toBe(false)
    expect(isOpenRemoteTabArgs(device, 'claude', undefined, null)).toBe(false)
    expect(isOpenRemoteTabArgs(device, 'claude', null, 42)).toBe(false)
    expect(isOpenRemoteTabArgs(device, 'claude', null, '')).toBe(false)
    expect(isOpenRemoteTabArgs(device, 'claude', null, 'x'.repeat(65))).toBe(false)
  })

  it('isAddressInput accepts 1 to MAX_ADDRESS_LENGTH characters', () => {
    expect(isAddressInput('a')).toBe(true)
    expect(isAddressInput('x'.repeat(MAX_ADDRESS_LENGTH))).toBe(true)
    expect(isAddressInput('')).toBe(false)
    expect(isAddressInput('x'.repeat(MAX_ADDRESS_LENGTH + 1))).toBe(false)
    expect(isAddressInput(5)).toBe(false)
  })

  it('isOptionalAddress accepts null or an address', () => {
    expect(isOptionalAddress(null)).toBe(true)
    expect(isOptionalAddress('macbook:47821')).toBe(true)
    expect(isOptionalAddress('')).toBe(false)
    expect(isOptionalAddress(undefined)).toBe(false)
  })

  it('isPairCodeInput accepts a string of at most 64 characters', () => {
    expect(isPairCodeInput('K7QM-2XPD-9TRA-W4BN')).toBe(true)
    expect(isPairCodeInput('x'.repeat(64))).toBe(true)
    expect(isPairCodeInput('x'.repeat(65))).toBe(false)
    expect(isPairCodeInput(null)).toBe(false)
  })

  it('isDeviceNameInput accepts a string of at most 256 characters', () => {
    expect(isDeviceNameInput('')).toBe(true)
    expect(isDeviceNameInput('x'.repeat(256))).toBe(true)
    expect(isDeviceNameInput('x'.repeat(257))).toBe(false)
    expect(isDeviceNameInput(3)).toBe(false)
  })

  it('isSeedText takes a string up to MAX_SNAPSHOT_BYTES characters', () => {
    expect(isSeedText('')).toBe(true)
    expect(isSeedText('x'.repeat(MAX_SNAPSHOT_BYTES))).toBe(true)
    expect(isSeedText('x'.repeat(MAX_SNAPSHOT_BYTES + 1))).toBe(false)
    expect(isSeedText(42)).toBe(false)
    expect(isSeedText(null)).toBe(false)
  })

  it('isSeedToken takes a safe integer of at least 1', () => {
    for (const v of [1, Number.MAX_SAFE_INTEGER]) expect(isSeedToken(v)).toBe(true)
    for (const v of [0, -1, 1.5, NaN, '1']) expect(isSeedToken(v)).toBe(false)
  })

  it('isFolderInput takes any typed folder as text, bounded', () => {
    for (const p of ['', '~', '~/src', 'C:\\work\\', '/Users/x', 'relative']) expect(isFolderInput(p)).toBe(true)
    expect(isFolderInput('x'.repeat(MAX_PATH_TEXT + 1))).toBe(false)
    expect(isFolderInput(null)).toBe(false)
  })

  it('isPathText takes a path of any system as text, bounded', () => {
    for (const p of ['C:\\work\\a.ts', '/Users/x/a.ts', 'a.ts']) expect(isPathText(p)).toBe(true)
    expect(isPathText('')).toBe(false)
    expect(isPathText('x'.repeat(MAX_PATH_TEXT))).toBe(true)
    expect(isPathText('x'.repeat(MAX_PATH_TEXT + 1))).toBe(false)
    expect(isPathText(1)).toBe(false)
    expect(isPathText(null)).toBe(false)
  })
})
