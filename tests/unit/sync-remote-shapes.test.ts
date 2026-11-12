import { describe, expect, it } from 'vitest'
import { CALL_ARGS, CALL_REPLIES, type CallMethod, parsePush, reviewRevOf } from '../../src/main/sync/remote-shapes'
import { MAX_IMAGE_BYTES } from '../../src/shared/image-file'
import { IMAGE_PART_BYTES, MAX_PATH_TEXT, MAX_REVIEW_PARTS, MAX_SNAPSHOT_BYTES, MAX_TRANSFER_BYTES, MAX_TRANSFER_FILES, MAX_TYPED_TEXT, TRANSFER_PART_BYTES } from '../../src/shared/remote'
import type { ReviewUpdate } from '../../src/shared/review'
import type { ImageCard } from '../../src/shared/types'

const T1 = '0a1b2c3d-0000-4000-8000-000000000001'
const T2 = '0a1b2c3d-0000-4000-8000-000000000002'
const S1 = 'a0000000-0000-4000-8000-000000000001'
const CARD = '0123456789abcdef0123'
const MIB = 1024 * 1024

const GOOD_ARGS: Array<[CallMethod, unknown]> = [
  ['attach', { id: T1 }],
  ['open-tab', { kind: 'claude', profile: 'Claude', account: null, resume: S1 }],
  ['open-tab', { kind: 'shell', profile: null, account: 'acc-1', resume: null }],
  ['close', { id: T1 }],
  ['images-seen', { id: T1 }],
  ['can-send', { id: T1 }],
  ['can-fork', { id: T1 }],
  ['fork-tab', { id: T1 }],
  ['restart', { id: T1, live: true }],
  ['rename', { id: T1, title: null }],
  ['rename', { id: T1, title: 'Build' }],
  ['mute', { id: T1, muted: true }],
  ['switch-account', { id: T1, account: null }],
  ['clear-task-list', { id: T1 }],
  ['image-remove', { id: T1, card: CARD }],
  ['image', { id: T1, card: CARD, offset: 0 }],
  ['review', { id: T1, action: { k: 'scope', scope: 'last_turn' } }],
  ['review', { id: T1, action: { k: 'clear' } }],
  ['review', { id: T1, action: { k: 'refresh' } }],
  ['review', { id: T1, action: { k: 'viewed', path: 'C:\\work\\a.ts', hash: 'abc123', viewed: true } }],
  ['review', { id: T1, action: { k: 'show', path: 'C:\\work\\a.ts' } }],
  ['profiles', {}],
  ['accounts', {}],
  ['tabs', {}],
  ['sessions', {}],
  ['open-session', { session: S1 }],
  ['folders', { id: T1, path: null }],
  ['folders', { id: T1, path: '~/src' }],
  ['change-folder', { id: T1, path: '/Users/x' }],
  ['change-folder', { id: T1, path: '' }],
  ['change-folder', { id: T1, path: '   ' }],
  ['recv-begin', { id: T1, files: [{ name: 'a.png', size: 0 }] }],
  ['recv-part', { transfer: T2, file: 0, offset: 0, data: 'AAAA' }],
  ['recv-end', { transfer: T2 }],
  ['recv-end', { transfer: T2, id: T1 }],
  ['chat-send', { id: T1, text: 'Fix the build', attachments: [] }],
  ['chat-send', { id: T1, text: '', attachments: [{ kind: 'image', path: 'C:\\work\\shot.png', name: 'shot.png', size: 10, cardId: CARD }] }],
  ['chat-send', { id: T1, text: 'see', attachments: [{ kind: 'file', path: '/Users/x/a.txt', name: 'a.txt', size: 0, cardId: null }] }],
  ['chat-answer', { id: T1, cardId: 'c1', answer: { type: 'permission', choice: 'deny', suggestion: null, message: null } }],
  ['chat-answer', { id: T1, cardId: 'c1', answer: { type: 'question', answers: null } }],
  ['chat-answer', { id: T1, cardId: 'c1', answer: { type: 'plan', choice: 'keep-planning', message: 'Wait' } }],
  ['chat-answer', { id: T1, cardId: 'c1', answer: { type: 'dialog', choice: null } }],
  ['chat-interrupt', { id: T1 }],
  ['chat-mode', { id: T1, mode: 'plan' }],
  ['chat-model', { id: T1, model: 'opus', effort: null }],
  ['chat-model', { id: T1, model: null, effort: 'high' }],
  ['chat-stop-task', { id: T1, taskId: 'task-1' }],
  ['chat-older', { id: T1, beforeId: 'item-1' }],
  ['chat-view', { id: T1, view: 'chat' }],
  ['chat-commands', { id: T1 }],
  ['chat-models', { id: T1 }],
  ['chat-modes', { id: T1 }],
  ['chat-files', { id: T1, query: 'src/' }],
  ['chat-terminal', { id: T1, line: 'ls' }],
  ['chat-terminal', { id: T1, line: '' }]
]

const BAD_ARGS: Array<[CallMethod, unknown]> = [
  ['attach', { id: 'x' }],
  ['attach', {}],
  ['open-tab', { kind: 'other', profile: 'Claude', account: null, resume: null }],
  ['open-tab', { kind: 'shell', profile: 'bash', account: null, resume: S1 }],
  ['open-tab', { kind: 'claude', profile: '', account: null, resume: null }],
  ['open-tab', { kind: 'claude', profile: 'Claude', account: '', resume: null }],
  ['open-tab', { kind: 'claude', profile: 'Claude', account: 'a\u0000b', resume: null }],
  ['close', { id: 'x' }],
  ['images-seen', { id: 5 }],
  ['can-send', {}],
  ['can-fork', { id: 'x' }],
  ['fork-tab', {}],
  ['restart', { id: T1, live: 'yes' }],
  ['rename', { id: T1, title: 'x'.repeat(1001) }],
  ['mute', { id: T1, muted: 1 }],
  ['switch-account', { id: T1, account: 'x'.repeat(65) }],
  ['clear-task-list', { id: 'x' }],
  ['clear-task-list', {}],
  ['image-remove', { id: T1, card: 'XYZ' }],
  ['image', { id: T1, card: CARD, offset: -1 }],
  ['image', { id: T1, card: CARD, offset: 2 ** 53 }],
  ['review', { id: T1, action: { k: 'scope', scope: 'all' } }],
  ['review', { id: T1, action: { k: 'show', path: 'x'.repeat(MAX_PATH_TEXT + 1) } }],
  ['review', { id: T1, action: { k: 'viewed', path: 'a', hash: '', viewed: true } }],
  ['review', { id: T1, action: { k: 'nope' } }],
  ['profiles', []],
  ['accounts', 'x'],
  ['tabs', null],
  ['sessions', null],
  ['open-session', { session: 'x' }],
  ['folders', { id: T1, path: 'x'.repeat(MAX_PATH_TEXT + 1) }],
  ['folders', { id: T1, path: 'a\u0000b' }],
  ['change-folder', { id: T1, path: 'x'.repeat(MAX_PATH_TEXT + 1) }],
  ['recv-begin', { id: T1, files: [{ name: 'a', size: 30 * MIB }, { name: 'b', size: 30 * MIB }] }],
  ['recv-begin', { id: T1, files: Array.from({ length: MAX_TRANSFER_FILES + 1 }, () => ({ name: 'a', size: 0 })) }],
  ['recv-begin', { id: T1, files: [] }],
  ['recv-begin', { id: T1, files: [{ name: '', size: 1 }] }],
  ['recv-part', { transfer: T2, file: 0, offset: 0, data: 'not base64!' }],
  ['recv-part', { transfer: T2, file: 100, offset: 0, data: 'AAAA' }],
  ['recv-part', { transfer: T2, file: 0, offset: 0, data: '' }],
  ['recv-part', { transfer: T2, file: 0, offset: 0, data: 'AAA' }],
  ['recv-part', { transfer: T2, file: 0, offset: 0, data: 'A'.repeat(4 * Math.ceil((TRANSFER_PART_BYTES + 1) / 3)) }],
  ['review', { id: T1, action: { k: 'viewed', path: 'a', hash: 'a\u0000b', viewed: true } }],
  ['recv-end', { transfer: 'x' }],
  ['recv-end', { transfer: T2, id: 'x' }],
  ['recv-end', { transfer: T2, id: 5 }],
  ['chat-send', { id: T1, text: 5, attachments: [] }],
  ['chat-send', { id: T1, text: 'x'.repeat(1024 * 1024 + 1), attachments: [] }],
  ['chat-send', { id: T1, text: 'hi', attachments: 'none' }],
  ['chat-send', { id: T1, text: 'hi', attachments: [{ kind: 'file', path: 'a.txt', name: 'a.txt', size: 1, cardId: null }] }],
  ['chat-send', { id: T1, text: 'hi', attachments: [{ kind: 'video', path: '/a.mp4', name: 'a.mp4', size: 1, cardId: null }] }],
  ['chat-send', { id: 'x', text: 'hi', attachments: [] }],
  ['chat-answer', { id: T1, cardId: 5, answer: { type: 'dialog', choice: null } }],
  ['chat-answer', { id: T1, cardId: '', answer: { type: 'dialog', choice: null } }],
  ['chat-answer', { id: T1, cardId: 'c1', answer: { type: 'nope' } }],
  ['chat-answer', { id: T1, cardId: 'c1', answer: { type: 'permission', choice: 'always', suggestion: null, message: null } }],
  ['chat-answer', { id: T1, cardId: 'c1' }],
  ['chat-interrupt', { id: 'x' }],
  ['chat-interrupt', {}],
  ['chat-mode', { id: T1, mode: 'yolo' }],
  ['chat-mode', { id: T1, mode: 3 }],
  ['chat-model', { id: T1, model: 5, effort: null }],
  ['chat-model', { id: T1, model: 'x'.repeat(201), effort: null }],
  ['chat-model', { id: T1, model: null }],
  ['chat-model', { id: T1, model: 'opus', effort: '' }],
  ['chat-stop-task', { id: T1, taskId: '' }],
  ['chat-stop-task', { id: T1, taskId: 5 }],
  ['chat-older', { id: T1, beforeId: 5 }],
  ['chat-older', { id: 'x', beforeId: 'item-1' }],
  ['chat-view', { id: T1, view: 'grid' }],
  ['chat-view', { id: T1, view: 5 }],
  ['chat-commands', { id: 'x' }],
  ['chat-commands', {}],
  ['chat-models', { id: 5 }],
  ['chat-modes', { id: 5 }],
  ['chat-files', { id: T1, query: 5 }],
  ['chat-files', { id: T1, query: 'x'.repeat(MAX_PATH_TEXT + 1) }],
  ['chat-terminal', { id: T1, line: 5 }],
  ['chat-terminal', { id: T1, line: 'x'.repeat(1024 * 1024 + 1) }]
]

describe('call arguments', () => {
  it('GOOD_ARGS and BAD_ARGS hold a case for every method of the table', () => {
    const methods = Object.keys(CALL_ARGS).sort()
    expect(methods).toHaveLength(38)
    expect([...new Set(GOOD_ARGS.map(([m]) => m))].sort()).toEqual(methods)
    expect([...new Set(BAD_ARGS.map(([m]) => m))].sort()).toEqual(methods)
  })

  it.each(GOOD_ARGS)('the arguments of %s pass unchanged', (m, a) => expect(CALL_ARGS[m](a)).toEqual(a))

  it.each(BAD_ARGS)('the arguments of %s are refused: %j', (m, a) => expect(CALL_ARGS[m](a)).toBeNull())

  it('a review path or folder from another system passes: the tab device reads it', () => {
    expect(CALL_ARGS.review({ id: T1, action: { k: 'show', path: 'C:\\work\\a.ts' } })).not.toBeNull()
    expect(CALL_ARGS.folders({ id: T1, path: '~/src' })).not.toBeNull()
    expect(CALL_ARGS.folders({ id: T1, path: '/Users/x' })).not.toBeNull()
  })

  it('the arguments keep only the known fields', () => {
    expect(CALL_ARGS.close({ id: T1, extra: 1 })).toEqual({ id: T1 })
  })

  it('a transfer of exactly the limit in all passes; one byte more is refused', () => {
    const half = MAX_TRANSFER_BYTES / 2
    expect(CALL_ARGS['recv-begin']({ id: T1, files: [{ name: 'a', size: half }, { name: 'b', size: half }] })).not.toBeNull()
    expect(CALL_ARGS['recv-begin']({ id: T1, files: [{ name: 'a', size: half }, { name: 'b', size: half + 1 }] })).toBeNull()
  })

  it('a part holding the largest base64 text of at most TRANSFER_PART_BYTES bytes passes', () => {
    const data = 'A'.repeat(4 * Math.floor(TRANSFER_PART_BYTES / 3))
    expect(CALL_ARGS['recv-part']({ transfer: T2, file: 0, offset: 0, data })).not.toBeNull()
  })

  // pins: the exact edge of a part, from Buffer's own base64
  it('a part of exactly TRANSFER_PART_BYTES passes; one byte more is refused', () => {
    const part = (n: number): unknown => ({ transfer: T2, file: 0, offset: 0, data: Buffer.alloc(n).toString('base64') })
    expect(CALL_ARGS['recv-part'](part(TRANSFER_PART_BYTES))).not.toBeNull()
    expect(CALL_ARGS['recv-part'](part(TRANSFER_PART_BYTES + 1))).toBeNull()
  })

  it('a hash holds no NUL and at most 128 characters: a binary hash of a SHA-256 repository passes', () => {
    const viewed = (hash: string): unknown => CALL_ARGS.review({ id: T1, action: { k: 'viewed', path: 'a', hash, viewed: true } })
    expect(viewed('a\u0000b')).toBeNull()
    expect(viewed('binary:' + 'a'.repeat(64))).not.toBeNull()
    expect(viewed('a'.repeat(128))).not.toBeNull()
    expect(viewed('a'.repeat(129))).toBeNull()
  })

  it('CALL_ARGS and CALL_REPLIES have no prototype: a method name from the network finds no entry', () => {
    expect((CALL_ARGS as Record<string, unknown>).constructor).toBeUndefined()
    expect((CALL_ARGS as Record<string, unknown>)['__proto__']).toBeUndefined()
    expect((CALL_REPLIES as Record<string, unknown>).constructor).toBeUndefined()
    expect((CALL_REPLIES as Record<string, unknown>)['__proto__']).toBeUndefined()
  })
})

describe('chat-modes', () => {
  it('its arguments are a tab id; its reply is at most six permission modes, each one a known mode', () => {
    expect(CALL_ARGS['chat-modes']({ id: T1 })).toEqual({ id: T1 })
    expect(CALL_ARGS['chat-modes']({ id: 5 })).toBeNull()
    expect(CALL_REPLIES['chat-modes'](['default', 'acceptEdits', 'plan', 'auto'])).toEqual(['default', 'acceptEdits', 'plan', 'auto'])
    expect(CALL_REPLIES['chat-modes'](['default', 'yolo'])).toBeNull()
    expect(CALL_REPLIES['chat-modes'](['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk', 'default'])).toBeNull()
    expect(CALL_REPLIES['chat-modes'](null)).toBeNull()
  })
})

describe('chat call replies', () => {
  it('a page of chat-older is its items and hasOlder; a null page is a failed call, and a bad item refuses the page', () => {
    expect(CALL_REPLIES['chat-older']({ items: [], hasOlder: false })).toEqual({ items: [], hasOlder: false })
    expect(CALL_REPLIES['chat-older']({ items: [{ kind: 'divider', id: 'd', text: 'Earlier' }], hasOlder: true })).not.toBeNull()
    expect(CALL_REPLIES['chat-older'](null)).toBeNull()
    expect(CALL_REPLIES['chat-older']({ items: [{ kind: 'nope', id: 'd' }], hasOlder: true })).toBeNull()
    expect(CALL_REPLIES['chat-older']({ items: [], hasOlder: 'no' })).toBeNull()
  })

  it('the lists of chat-files, chat-commands and chat-models check each entry', () => {
    expect(CALL_REPLIES['chat-files'](['src/a.ts'])).toEqual(['src/a.ts'])
    expect(CALL_REPLIES['chat-files']([5])).toBeNull()
    const command = { name: 'compact', description: 'Compact the conversation', argumentHint: '', group: 'builtin', source: null, terminal: false }
    expect(CALL_REPLIES['chat-commands']([command])).toEqual([command])
    expect(CALL_REPLIES['chat-commands']([{ ...command, group: 'other' }])).toBeNull()
    const model = { value: 'opus', displayName: 'Opus', description: 'Most capable', efforts: ['high'] }
    expect(CALL_REPLIES['chat-models']([model])).toEqual([model])
    expect(CALL_REPLIES['chat-models']([{ value: 'opus' }])).toBeNull()
    // the id the model resolves to: optional (an older device sends none), bounded when it comes
    const resolved = { ...model, resolved: 'claude-opus-5-5' }
    expect(CALL_REPLIES['chat-models']([resolved])).toEqual([resolved])
    expect(CALL_REPLIES['chat-models']([{ ...model, resolved: 'x'.repeat(501) }])).toBeNull()
    expect(CALL_REPLIES['chat-models']([{ ...model, resolved: 5 }])).toBeNull()
    // whether the model runs auto mode: optional (an older device sends none), a boolean when it comes
    expect(CALL_REPLIES['chat-models']([{ ...model, autoMode: true }])).toEqual([{ ...model, autoMode: true }])
    expect(CALL_REPLIES['chat-models']([{ ...model, autoMode: false }])).toEqual([{ ...model, autoMode: false }])
    expect(CALL_REPLIES['chat-models']([{ ...model, autoMode: 'yes' }])).toBeNull()
  })

  it('the chat calls that answer with nothing take an object, and a null reply is a failed call', () => {
    expect(CALL_REPLIES['chat-send']({})).toEqual({})
    expect(CALL_REPLIES['chat-answer']({ ok: true })).toEqual({ ok: true })
    expect(CALL_REPLIES['chat-answer']({ ok: false })).toEqual({ ok: false })
    expect(CALL_REPLIES['chat-answer']({})).toBeNull()
    expect(CALL_REPLIES['chat-terminal'](null)).toBeNull()
  })
})

describe('call replies', () => {
  it('tabs answers an empty reply: the directory comes as a push, so the reply holds no list', () => {
    expect(CALL_REPLIES.tabs({})).toEqual({})
    expect(CALL_REPLIES.tabs([])).toBeNull()
    expect(CALL_REPLIES.tabs({ anything: 1 })).toEqual({})
    expect(CALL_REPLIES.tabs('x')).toBeNull()
    expect(CALL_REPLIES.tabs(null)).toBeNull()
  })

  it('attach, open-tab and the other replies take their shapes', () => {
    const snapshot = { data: 'hello\u0000', seq: 0, cols: 80, rows: 24 }
    expect(CALL_REPLIES.attach(snapshot)).toEqual(snapshot)
    expect(CALL_REPLIES.attach({ data: 'x'.repeat(MAX_SNAPSHOT_BYTES + 1), seq: 0, cols: 80, rows: 24 })).toBeNull()
    expect(CALL_REPLIES.attach({ data: '', seq: -1, cols: 80, rows: 24 })).toBeNull()
    expect(CALL_REPLIES.attach({ data: '', seq: 0, cols: 0, rows: 24 })).toBeNull()
    expect(CALL_REPLIES['open-tab']({ id: T1 })).toEqual({ id: T1 })
    expect(CALL_REPLIES['open-tab']({ id: 'x' })).toBeNull()
    expect(CALL_REPLIES['open-session']({ id: T1 })).toEqual({ id: T1 })
    expect(CALL_REPLIES.close({ anything: 1 })).toEqual({})
    expect(CALL_REPLIES.close(null)).toBeNull()
    expect(CALL_REPLIES['switch-account']({ ok: true })).toEqual({ ok: true })
    expect(CALL_REPLIES['switch-account']({ ok: 'yes' })).toBeNull()
    expect(CALL_REPLIES['clear-task-list']({ ok: false })).toEqual({ ok: false })
    expect(CALL_REPLIES['clear-task-list']({})).toBeNull()
    expect(CALL_REPLIES['recv-begin']({ transfer: T2 })).toEqual({ transfer: T2 })
    expect(CALL_REPLIES['recv-end']({ paths: ['D:\\tmp\\a.png'] })).toEqual({ paths: ['D:\\tmp\\a.png'] })
    expect(CALL_REPLIES['recv-end']({ paths: Array(MAX_TRANSFER_FILES + 1).fill('a') })).toBeNull()
    expect(CALL_REPLIES['recv-end']({ paths: ['D:\\tmp\\a.png'], text: '"D:\\tmp\\a.png"' })).toEqual({ paths: ['D:\\tmp\\a.png'], text: '"D:\\tmp\\a.png"' })
    expect(CALL_REPLIES['recv-end']({ paths: ['a'], text: 'x'.repeat(MAX_TYPED_TEXT) })).not.toBeNull()
    expect(CALL_REPLIES['recv-end']({ paths: ['a'], text: '' })).toBeNull()
    expect(CALL_REPLIES['recv-end']({ paths: ['a'], text: 'x'.repeat(MAX_TYPED_TEXT + 1) })).toBeNull()
    expect(CALL_REPLIES['recv-end']({ paths: ['a'], text: 5 })).toBeNull()
  })

  it('a recv-end text of the bash quoting of MAX_TRANSFER_FILES paths of MAX_PATH_TEXT apostrophes each is accepted', () => {
    // bash and zsh write each ' as '\'' (4 characters), inside two outer quotes
    const quoted = "'" + "'\\''".repeat(MAX_PATH_TEXT) + "'"
    const text = Array(MAX_TRANSFER_FILES).fill(quoted).join(' ')
    const paths = Array(MAX_TRANSFER_FILES).fill("'".repeat(MAX_PATH_TEXT))
    expect(CALL_REPLIES['recv-end']({ paths, text })).not.toBeNull()
  })

  it('can-fork answers { ok }, and fork-tab answers the new tab\'s id', () => {
    expect(CALL_REPLIES['can-fork']({ ok: false })).toEqual({ ok: false })
    expect(CALL_REPLIES['can-fork']({ ok: 'yes' })).toBeNull()
    expect(CALL_REPLIES['fork-tab']({ id: T2 })).toEqual({ id: T2 })
    expect(CALL_REPLIES['fork-tab']({ id: 'x' })).toBeNull()
  })

  it('can-send replies with the send state, and its reason is at most 500 characters', () => {
    expect(CALL_REPLIES['can-send']({ ok: true })).toEqual({ ok: true })
    expect(CALL_REPLIES['can-send']({ ok: false, reason: 'Claude is not running in this tab' })).toEqual({ ok: false, reason: 'Claude is not running in this tab' })
    expect(CALL_REPLIES['can-send']({ ok: false, reason: 'x'.repeat(501) })).toBeNull()
  })

  it('image replies carry a version, a size and at most IMAGE_PART_BYTES of base64', () => {
    expect(CALL_REPLIES.image({ version: 1, size: 3, data: 'AAAA' })).toEqual({ version: 1, size: 3, data: 'AAAA' })
    expect(CALL_REPLIES.image({ version: 0, size: 3, data: 'AAAA' })).toBeNull()
    expect(CALL_REPLIES.image({ version: 1, size: MAX_IMAGE_BYTES + 1, data: 'AAAA' })).toBeNull()
    expect(CALL_REPLIES.image({ version: 1, size: 3, data: 'not base64' })).toBeNull()
    const tooBig = 'A'.repeat(4 * Math.ceil((IMAGE_PART_BYTES + 1) / 3))
    expect(CALL_REPLIES.image({ version: 1, size: 3, data: tooBig })).toBeNull()
  })

  it('profiles and accounts are lists of names; a bad entry refuses the list', () => {
    expect(CALL_REPLIES.profiles(['Bash'])).toEqual(['Bash'])
    expect(CALL_REPLIES.profiles(['x'.repeat(257)])).toBeNull()
    expect(CALL_REPLIES.profiles(Array(65).fill('Bash'))).toBeNull()
    expect(CALL_REPLIES.accounts([{ id: 'acc-1', name: 'Work' }])).toEqual([{ id: 'acc-1', name: 'Work' }])
    expect(CALL_REPLIES.accounts([{ id: 'acc-1', name: '' }])).toBeNull()
    expect(CALL_REPLIES.accounts([{ id: 'acc-1', name: 'Work', extra: 1 }])).toEqual([{ id: 'acc-1', name: 'Work' }])
  })

  it('sessions are checked one by one: a bad entry is left out and the good ones are kept (R9); a session of another device loses its device field', () => {
    expect(CALL_REPLIES.sessions([{ ...session(), id: undefined }])).toEqual([])
    expect(CALL_REPLIES.sessions([{ ...session(), device: 'Studio' }])).toEqual([session()])
    expect(CALL_REPLIES.sessions([session(), { ...session(), title: 'x'.repeat(2001) }])).toEqual([session()])
    expect(CALL_REPLIES.sessions(Array(1001).fill(session()))).toBeNull()
    expect(CALL_REPLIES.sessions({ 0: session() })).toBeNull()
    expect(CALL_REPLIES.sessions([{ ...session(), modifiedAt: -1 }, session()])).toEqual([session()])
  })

  it('folders answers a listing or an error; a folder name holding a separator is refused', () => {
    expect(CALL_REPLIES.folders({ ok: true, listing: listing() })).toEqual({ ok: true, listing: listing() })
    expect(CALL_REPLIES.folders({ ok: false, error: 'This folder does not exist' })).toEqual({ ok: false, error: 'This folder does not exist' })
    expect(CALL_REPLIES.folders({ ok: false, error: 'x'.repeat(501) })).toBeNull()
    expect(CALL_REPLIES.folders({ ok: true, listing: { ...listing(), folders: ['a/b'] } })).toBeNull()
    expect(CALL_REPLIES.folders({ ok: true, listing: { ...listing(), folders: ['a\\b'] } })).toBeNull()
    expect(CALL_REPLIES.folders({ ok: true, listing: { ...listing(), sep: '|' } })).toBeNull()
    expect(CALL_REPLIES.folders({ ok: true, listing: { ...listing(), device: '' } })).toBeNull()
    expect(CALL_REPLIES.folders({ ok: true, listing: { ...listing(), folders: [1] } })).toBeNull()
    expect(CALL_REPLIES.folders({ ok: true, listing: listing({ parent: null }) })).toEqual({ ok: true, listing: listing({ parent: null }) })
  })
})

const reviewFile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  path: 'C:\\work\\a.ts',
  relPath: 'a.ts',
  status: 'modified',
  additions: 1,
  deletions: 0,
  hunks: [{ header: '@@ -1 +1,2 @@', lines: [{ kind: 'add', text: 'x', oldNo: null, newNo: 2 }] }],
  note: null,
  canForce: false,
  hash: 'abc123',
  viewed: false,
  markdown: false,
  lineCount: 2,
  ...over
})

const reviewWithoutTab = (): Omit<ReviewUpdate, 'tabId'> => ({
  view: { kind: 'scope', scope: 'uncommitted' },
  label: 'uncommitted',
  uncommitted: { available: true },
  files: [reviewFile() as unknown as ReviewUpdate['files'][number]],
  additions: 1,
  deletions: 0,
  unviewed: 1,
  ignored: 0,
  hideTests: false,
  renderMarkdown: false,
  testsHidden: 0,
  testsSample: [],
  outside: 0,
  outsideSample: [],
  folder: 'D:\\work',
  notice: null,
  send: { ok: true },
  counter: { files: 1, additions: 1, deletions: 0, title: '1 file changed' },
  reveal: false
})

const session = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: S1,
  cwd: 'D:\\Workspace\\app',
  title: 'Fix build',
  firstPrompt: 'Fix the build',
  lastPrompt: null,
  modifiedAt: 1700000000000.5,
  open: false,
  starred: true,
  ...over
})

const listing = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  device: 'Studio',
  path: 'D:\\work',
  sep: '\\',
  parent: 'D:\\',
  folders: ['app', 'docs'],
  recent: ['D:\\work\\app'],
  ...over
})

const agent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: 'agent-1',
  type: 'Explore',
  description: 'Find files',
  model: 'haiku',
  effort: null,
  startedAt: 1700000000000,
  ...over
})

const main = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: { id: 'claude-opus-4', displayName: 'Opus 4' },
  effort: 'high',
  context: { usedTokens: 1000, size: 200000, usedPct: 0.5 },
  fiveHour: { usedPct: 12, resetsAt: 1700000000 },
  sevenDay: null,
  ...over
})

const card = (over: Partial<ImageCard> = {}): ImageCard => ({
  id: CARD,
  tabId: T1,
  path: 'D:\\work\\shot.png',
  name: 'shot.png',
  relPath: 'shot.png',
  source: 'shown',
  kind: 'image',
  caption: null,
  touchedAt: 1700000000000,
  version: 1,
  updated: false,
  deleted: false,
  ...over
})

const plan = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Ship device sync',
  tasks: [
    { n: 1, title: 'Design', state: 'done' },
    { n: 2, title: 'Build', state: 'current' },
    { n: 3, title: 'Test', state: 'left' }
  ],
  done: 1,
  total: 3,
  finished: false,
  ...over
})

describe('pushes', () => {
  it('an images push holding a card of another tab is refused', () => {
    expect(parsePush('images', { cards: [card({ tabId: T2 })], unseen: 0, notice: null }, T1)).toBeNull()
  })

  it('an images push keeps the cards of its tab and refuses a bad card', () => {
    expect(parsePush('images', { cards: [card()], unseen: 1, notice: 'Saved' }, T1)).toEqual({
      k: 'images',
      v: { cards: [card()], unseen: 1, notice: 'Saved' }
    })
    expect(parsePush('images', { cards: [{ ...card(), id: 'XYZ' }], unseen: 0, notice: null }, T1)).toBeNull()
    expect(parsePush('images', { cards: [{ ...card(), kind: 'pdf' }], unseen: 0, notice: null }, T1)).toBeNull()
    expect(parsePush('images', { cards: [{ ...card(), name: '' }], unseen: 0, notice: null }, T1)).toBeNull()
    expect(parsePush('images', { cards: [], unseen: -1, notice: null }, T1)).toBeNull()
    expect(parsePush('images', { cards: Array(10_001).fill(card()), unseen: 0, notice: null }, T1)).toBeNull()
    expect(parsePush('images', { cards: [], unseen: 0, notice: 'x'.repeat(501) }, T1)).toBeNull()
  })

  it('a review push keeps the fields the panel reads and drops the rest', () => {
    const v = { ...reviewWithoutTab(), extra: 1 }
    expect(parsePush('review', v, T1)).toEqual({ k: 'review', v: reviewWithoutTab() })
  })

  it('a review push keeps the counter as RemoteTab does, and refuses one that is not a counter', () => {
    expect(parsePush('review', { ...reviewWithoutTab(), counter: null }, T1)).toEqual({ k: 'review', v: { ...reviewWithoutTab(), counter: null } })
    expect(parsePush('review', { ...reviewWithoutTab(), counter: { files: -1, additions: 0, deletions: 0, title: '' } }, T1)).toBeNull()
  })

  it('a review push refuses a file hash holding a NUL, and takes a binary hash of 71 characters', () => {
    expect(parsePush('review', { ...reviewWithoutTab(), files: [reviewFile({ hash: 'a\u0000b' })] }, T1)).toBeNull()
    expect(parsePush('review', { ...reviewWithoutTab(), files: [reviewFile({ hash: 'binary:' + 'a'.repeat(64) })] }, T1)).not.toBeNull()
  })

  it('a review push over the limits is refused', () => {
    expect(parsePush('review', { ...reviewWithoutTab(), files: Array(5001).fill(reviewFile()) }, T1)).toBeNull()
    expect(parsePush('review', { ...reviewWithoutTab(), files: [reviewFile({ hunks: Array(10_001).fill({ header: '', lines: [] }) })] }, T1)).toBeNull()
    expect(parsePush('review', { ...reviewWithoutTab(), files: [reviewFile({ hunks: [{ header: '', lines: [{ kind: 'add', text: 'x'.repeat(100_001), oldNo: null, newNo: 1 }] }] })] }, T1)).toBeNull()
    expect(parsePush('review', { ...reviewWithoutTab(), testsSample: Array(11).fill('a') }, T1)).toBeNull()
    expect(parsePush('review', { ...reviewWithoutTab(), folder: 'a\u0000b' }, T1)).toBeNull()
  })

  it('a status push with more than 64 agents is refused', () => {
    expect(parsePush('status', { main: null, agents: Array(65).fill(agent()), background: [] }, T1)).toBeNull()
  })

  it('a status push from a device that sends no background tasks has none', () => {
    expect(parsePush('status', { main: main(), agents: [agent()] }, T1)).toEqual({
      k: 'status',
      v: { main: main(), agents: [agent()], background: [] }
    })
  })

  it('background tasks: at most 64; an id or type of 201 characters or with a NUL, and a description or command that is not text, are refused', () => {
    const task = (over: object = {}) => ({ id: 'b1', type: 'shell', description: null, command: null, ...over })
    expect(parsePush('status', { main: null, agents: [], background: Array(65).fill(task()) }, T1)).toBeNull()
    expect(parsePush('status', { main: null, agents: [], background: [task({ id: 'x'.repeat(201) })] }, T1)).toBeNull()
    expect(parsePush('status', { main: null, agents: [], background: [task({ id: 'a\u0000b' })] }, T1)).toBeNull()
    expect(parsePush('status', { main: null, agents: [], background: [task({ type: 'a\u0000b' })] }, T1)).toBeNull()
    expect(parsePush('status', { main: null, agents: [], background: [task({ command: 7 })] }, T1)).toBeNull()
  })

  it('a file without lineCount reads as 0, so it has no tail gap; a lineCount that is not a count is refused', () => {
    const push = (file: Record<string, unknown>) => parsePush('review', { ...reviewWithoutTab(), files: [reviewFile(file)] }, T1)
    expect(push({ lineCount: undefined })).toMatchObject({ v: { files: [{ lineCount: 0 }] } })
    expect(push({ lineCount: -1 })).toBeNull()
    expect(push({ lineCount: 1.5 })).toBeNull()
    expect(push({ lineCount: '2' })).toBeNull()
  })

  it('a status push keeps the status, the agents and the background tasks, and drops the rest', () => {
    const task = { id: 'b1', type: 'shell', description: 'build', command: 'npm run build' }
    expect(parsePush('status', { main: main(), agents: [agent()], background: [task], extra: 1 }, T1)).toEqual({
      k: 'status',
      v: { main: main(), agents: [agent()], background: [task] }
    })
    expect(parsePush('status', { main: main({ model: { id: 'x'.repeat(201), displayName: 'Opus' } }), agents: [], background: [] }, T1)).toBeNull()
    expect(parsePush('status', { main: main({ context: { usedTokens: 1, size: 2, usedPct: Number.NaN } }), agents: [], background: [] }, T1)).toBeNull()
    expect(parsePush('status', { main: null, agents: [agent({ startedAt: 'now' })], background: [] }, T1)).toBeNull()
    expect(parsePush('status', { main: null, agents: [], background: [{ id: 'b1', type: 'shell', description: null }] }, T1)).toBeNull()
  })

  it('a plan push keeps the plan and whether it is the agent\'s task list; null is the plan going away', () => {
    expect(parsePush('plan', plan(), T1)).toEqual({ k: 'plan', v: plan(), agentList: false })
    expect(parsePush('plan', plan({ agentList: false }), T1)).toEqual({ k: 'plan', v: plan(), agentList: false })
    expect(parsePush('plan', plan({ agentList: true }), T1)).toEqual({ k: 'plan', v: plan(), agentList: true })
    expect(parsePush('plan', null, T1)).toEqual({ k: 'plan', v: null, agentList: false })
    expect(parsePush('plan', plan({ tasks: Array(501).fill({ n: 1, title: 'x', state: 'left' }) }), T1)).toBeNull()
    expect(parsePush('plan', plan({ tasks: [{ n: 1, title: 'x', state: 'doing' }] }), T1)).toBeNull()
    expect(parsePush('plan', plan({ done: -1 }), T1)).toBeNull()
    expect(parsePush('plan', plan({ finished: 'no' }), T1)).toBeNull()
    expect(parsePush('plan', plan({ title: 'x'.repeat(501) }), T1)).toBeNull()
    // the flag is true, false or absent: anything else drops the whole push
    for (const agentList of ['yes', 1, null, {}]) expect(parsePush('plan', plan({ agentList }), T1)).toBeNull()
  })

  it('a push of a kind this version does not know is refused', () => {
    expect(parsePush('weather' as 'status', {}, T1)).toBeNull()
  })
})

// Task 9: a review over 2 MiB comes as ordered parts; the part carries the head only in part 0
describe('review parts and the rev of a review (Task 9)', () => {
  const headOf = (): Record<string, unknown> => {
    const head: Record<string, unknown> = { ...reviewWithoutTab() }
    delete head.files
    return head
  }
  const part = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    rev: 2,
    i: 0,
    of: 2,
    head: headOf(),
    files: [reviewFile()],
    ...over
  })

  it('a good part 0 with its head, and a good later part with files only, are accepted', () => {
    expect(parsePush('review-part', part(), T1)).toMatchObject({ k: 'review-part', part: { rev: 2, i: 0, of: 2 } })
    expect(parsePush('review-part', { rev: 2, i: 1, of: 2, files: [reviewFile()] }, T1)).toMatchObject({ k: 'review-part', part: { i: 1 } })
  })

  it('a part refuses an index past its count, a count past MAX_REVIEW_PARTS, and a head in the wrong part', () => {
    expect(parsePush('review-part', part({ i: 2 }), T1)).toBeNull()
    expect(parsePush('review-part', part({ i: 3, of: 2 }), T1)).toBeNull()
    expect(parsePush('review-part', part({ of: MAX_REVIEW_PARTS + 1 }), T1)).toBeNull()
    expect(parsePush('review-part', part({ of: MAX_REVIEW_PARTS }), T1)).not.toBeNull()
    expect(parsePush('review-part', part({ head: undefined }), T1)).toBeNull()
    expect(parsePush('review-part', { ...part(), i: 1 }, T1)).toBeNull()
  })

  it('a part whose text alone is clearly over REVIEW_PART_BYTES is refused; one just under it is accepted', () => {
    const line = { kind: 'add', text: 'x'.repeat(100_000), oldNo: null, newNo: 1 }
    const withLines = (n: number) => part({ files: [reviewFile({ hunks: [{ header: '@@', lines: Array(n).fill(line) }] })] })
    expect(parsePush('review-part', withLines(19), T1)).not.toBeNull()
    expect(parsePush('review-part', withLines(23), T1)).toBeNull()
  })

  it('a part refuses a rev that is not a non-negative integer, and a file the review refuses', () => {
    expect(parsePush('review-part', part({ rev: 1.5 }), T1)).toBeNull()
    expect(parsePush('review-part', part({ rev: -1 }), T1)).toBeNull()
    expect(parsePush('review-part', part({ rev: '2' }), T1)).toBeNull()
    expect(parsePush('review-part', part({ files: [reviewFile({ hash: 'a\u0000b' })] }), T1)).toBeNull()
  })

  it('a review push carries its rev, and a review without one is shown as before (no rev)', () => {
    expect(reviewRevOf({ ...reviewWithoutTab(), rev: 3 })).toBe(3)
    expect(reviewRevOf(reviewWithoutTab())).toBeNull()
    expect(parsePush('review', { ...reviewWithoutTab(), rev: 3 }, T1)).not.toBeNull()
    expect(parsePush('review', { ...reviewWithoutTab(), rev: 'x' }, T1)).toBeNull()
    expect(parsePush('review', { ...reviewWithoutTab(), rev: 1.5 }, T1)).toBeNull()
  })
})
