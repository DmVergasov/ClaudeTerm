import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeProjectsDir, HEAD_BYTES, oneLine, parseSessionHead, parseSessionTail, SessionHistory, TAIL_BYTES, WIDE_TAIL_BYTES,
  type HistoryFs
} from '../../src/main/session-history'

const SID1 = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const SID3 = '6e3d2c8b-9f50-4b4c-a2d3-e4f5a6b7c8d9'
const ROOT = join('C:', 'cfg', 'projects')

const jsonl = (...entries: object[]): string => entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
const user = (cwd: string, content: unknown, over: object = {}): object => ({ type: 'user', cwd, entrypoint: 'cli', isSidechain: false, message: { role: 'user', content }, ...over })
const attachment = (cwd: string, size = 100): object => ({ type: 'attachment', cwd, entrypoint: 'cli', isSidechain: false, attachment: 'x'.repeat(size) })

/** an in-memory file system keyed by full path; reads are recorded as "<path>@<start>+<length>" */
function memFs(files: Record<string, { text: string; mtimeMs: number }>, failing: string[] = []) {
  const reads: string[] = []
  const fs: HistoryFs = {
    readdir: async (dir) => {
      const prefix = dir + '\\'
      const names = new Set<string>()
      for (const p of Object.keys(files)) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('\\')[0])
      if (names.size === 0) throw new Error(`ENOENT ${dir}`)
      return [...names]
    },
    stat: async (path) => {
      const f = files[path]
      if (!f) return { size: 0, mtimeMs: 0, isFile: () => false }
      return { size: Buffer.byteLength(f.text), mtimeMs: f.mtimeMs, isFile: () => true }
    },
    read: async (path, start, length) => {
      if (failing.includes(path)) throw new Error('EBUSY')
      reads.push(`${path}@${start}+${length}`)
      return Buffer.from(files[path].text).subarray(start, start + length).toString('utf8')
    }
  }
  return { fs, reads }
}

describe('oneLine', () => {
  it('collapses whitespace, trims, cuts to 200 characters; nothing → null', () => {
    expect(oneLine('  fix   the\nlogin  ')).toBe('fix the login')
    expect(oneLine('x'.repeat(500))).toHaveLength(200)
    expect(oneLine('   ')).toBeNull()
    expect(oneLine(7)).toBeNull()
  })
})

describe('parseSessionHead', () => {
  it('reads the folder, the first message and that a conversation started', () => {
    const text = jsonl({ type: 'mode', mode: 'default' }, user('D:\\a', '  fix   the\nlogin  '))
    expect(parseSessionHead(text, true)).toEqual({ cwd: 'D:\\a', firstPrompt: 'fix the login', hasUser: true })
  })

  it('takes the folder from a leading attachment when no user entry is in the window', () => {
    expect(parseSessionHead(jsonl({ type: 'last-prompt', lastPrompt: 'x' }, attachment('D:\\a')), true)).toEqual({ cwd: 'D:\\a', firstPrompt: null, hasUser: false })
  })

  it('claude -p runs and sidechains are not sessions; without a folder in the window the folder is unknown', () => {
    expect(parseSessionHead(jsonl(user('D:\\a', 'hi', { entrypoint: 'sdk-cli' })), true)).toBeNull()
    expect(parseSessionHead(jsonl(user('D:\\a', 'hi', { entrypoint: 'print' })), true)).toBeNull()
    expect(parseSessionHead(jsonl(user('D:\\a', 'hi', { isSidechain: true })), true)).toBeNull()
    expect(parseSessionHead(jsonl({ type: 'bridge-session', id: 'b' }), true)).toEqual({ cwd: null, firstPrompt: null, hasUser: false })
    expect(parseSessionHead('', true)).toEqual({ cwd: null, firstPrompt: null, hasUser: false })
  })

  it('sessions from the VS Code extension and the desktop app are interactive too', () => {
    expect(parseSessionHead(jsonl(user('D:\\a', 'hi', { entrypoint: 'claude-vscode' })), true)?.cwd).toBe('D:\\a')
    expect(parseSessionHead(jsonl(user('D:\\a', 'hi', { entrypoint: 'claude-desktop' })), true)?.cwd).toBe('D:\\a')
    expect(parseSessionHead(jsonl(user('D:\\a', 'hi', { entrypoint: 'sdk-ts' })), true)).toBeNull()
  })

  it('a session started with a slash command is named after it, unless a message was typed', () => {
    const command = user('D:\\a', '<command-message>ship-build</command-message>\n<command-name>/ship-build</command-name>\n<command-args>android  release</command-args>')
    expect(parseSessionHead(jsonl(command), true)?.firstPrompt).toBe('/ship-build android release')
    expect(parseSessionHead(jsonl(user('D:\\a', '<command-name>/mcp</command-name>')), true)?.firstPrompt).toBe('/mcp')
    expect(parseSessionHead(jsonl(command, user('D:\\a', 'hello')), true)?.firstPrompt).toBe('hello')
  })

  it('a missing entrypoint (older Claude Code) counts as interactive', () => {
    const text = jsonl({ type: 'user', cwd: 'D:\\a', message: { role: 'user', content: 'hi' } })
    expect(parseSessionHead(text, true)?.firstPrompt).toBe('hi')
  })

  it('skips meta entries, command wrappers and tool results for the first message; joins text blocks', () => {
    const text = jsonl(
      user('D:\\a', 'Caveat: the messages below were generated…', { isMeta: true }),
      user('D:\\a', '<command-name>/clear</command-name>'),
      user('D:\\a', [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
      user('D:\\a', [{ type: 'text', text: 'add' }, { type: 'image', source: {} }, { type: 'text', text: 'payments' }])
    )
    expect(parseSessionHead(text, true)?.firstPrompt).toBe('add payments')
  })

  it('drops the line cut by the window end and broken lines', () => {
    const text = jsonl(user('D:\\a', 'first')) + 'not json\n' + '{"type":"user","cwd":"D:\\\\b","message":{"content":"cut'
    expect(parseSessionHead(text, false)).toEqual({ cwd: 'D:\\a', firstPrompt: 'first', hasUser: true })
  })

  it('a first message longer than the head window: folder from a leading entry, no first message', () => {
    const big = jsonl(attachment('D:\\a'), user('D:\\a', 'p'.repeat(HEAD_BYTES * 2)))
    const head = Buffer.from(big).subarray(0, HEAD_BYTES).toString('utf8')
    expect(parseSessionHead(head, false)).toEqual({ cwd: 'D:\\a', firstPrompt: null, hasUser: false })
  })
})

describe('parseSessionTail', () => {
  it('the last title and message win; a /rename name is kept apart from the generated title', () => {
    const text = jsonl(
      { type: 'ai-title', aiTitle: 'A1' }, { type: 'last-prompt', lastPrompt: 'p1' },
      { type: 'custom-title', customTitle: 'Mine' }, { type: 'ai-title', aiTitle: 'A2' }, { type: 'last-prompt', lastPrompt: 'p2' }
    )
    expect(parseSessionTail(text, true)).toEqual({ customTitle: 'Mine', aiTitle: 'A2', lastPrompt: 'p2', folder: null })
  })

  it('drops the first line when the window starts inside the file', () => {
    const text = '"ai-title","aiTitle":"cut"}\n' + jsonl({ type: 'ai-title', aiTitle: 'whole' })
    expect(parseSessionTail(text, false).aiTitle).toBe('whole')
  })

  it('a half-written last line is ignored', () => {
    const text = jsonl({ type: 'ai-title', aiTitle: 'Done' }) + '{"type":"ai-title","aiTitle":"Half'
    expect(parseSessionTail(text, true)).toEqual({ customTitle: null, aiTitle: 'Done', lastPrompt: null, folder: null })
  })
})

describe('claudeProjectsDir', () => {
  it('uses CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: 'E:\\cfg' }, 'C:\\Users\\me')).toBe(join('E:\\cfg', 'projects'))
    expect(claudeProjectsDir({}, 'C:\\Users\\me')).toBe(join('C:\\Users\\me', '.claude', 'projects'))
  })
})

describe('SessionHistory', () => {
  const file = (folder: string, name: string): string => join(ROOT, folder, name)

  it('lists sessions newest first and skips claude -p runs, other files and subagent folders', async () => {
    const { fs } = memFs({
      [file('D--a', `${SID1}.jsonl`)]: { text: jsonl(user('D:\\a', 'one?'), { type: 'ai-title', aiTitle: 'One' }, { type: 'last-prompt', lastPrompt: 'one?' }), mtimeMs: 1000 },
      [file('D--b', `${SID2}.jsonl`)]: { text: jsonl(user('D:\\b', 'two?'), { type: 'custom-title', customTitle: 'Two' }), mtimeMs: 3000 },
      [file('D--b', `${SID3}.jsonl`)]: { text: jsonl(user('D:\\b', 'scripted', { entrypoint: 'sdk-cli' })), mtimeMs: 4000 },
      [file('D--b', 'notes.jsonl')]: { text: jsonl(user('D:\\b', 'x')), mtimeMs: 5000 },
      [file('D--b', `${SID2}\\subagents\\agent-1.jsonl`)]: { text: jsonl(user('D:\\b', 'sub')), mtimeMs: 6000 }
    })
    expect(await new SessionHistory(ROOT, fs).list(10)).toEqual([
      { id: SID2, cwd: 'D:\\b', title: 'Two', firstPrompt: 'two?', lastPrompt: null, modifiedAt: 3000 },
      { id: SID1, cwd: 'D:\\a', title: 'One', firstPrompt: 'one?', lastPrompt: 'one?', modifiedAt: 1000 }
    ])
  })

  it('the limit counts listed sessions only', async () => {
    const { fs } = memFs({
      [file('D--a', `${SID1}.jsonl`)]: { text: jsonl(user('D:\\a', 'old')), mtimeMs: 1000 },
      [file('D--a', `${SID2}.jsonl`)]: { text: jsonl(user('D:\\a', 'mid')), mtimeMs: 2000 },
      [file('D--a', `${SID3}.jsonl`)]: { text: jsonl(user('D:\\a', 'p', { entrypoint: 'sdk-cli' })), mtimeMs: 3000 }
    })
    expect((await new SessionHistory(ROOT, fs).list(1)).map((s) => s.id)).toEqual([SID2])
  })

  it('reads the last 2 MB once when the last 256 KB hold no title or message', async () => {
    const filler = Array.from({ length: 400 }, () => attachment('D:\\a', 1000))
    const text = jsonl(user('D:\\a', 'start'), { type: 'ai-title', aiTitle: 'Deep' }, ...filler)
    const path = file('D--a', `${SID1}.jsonl`)
    const { fs, reads } = memFs({ [path]: { text, mtimeMs: 1 } })
    const [s] = await new SessionHistory(ROOT, fs).list(10)
    expect(s.title).toBe('Deep')
    const size = Buffer.byteLength(text)
    expect(reads).toEqual([`${path}@0+${HEAD_BYTES}`, `${path}@${size - TAIL_BYTES}+${TAIL_BYTES}`, `${path}@0+${size}`])
    expect(size).toBeLessThan(WIDE_TAIL_BYTES)
  })

  it('a conversation proven only by last-prompt is listed; a file with neither user entry nor last-prompt is not', async () => {
    const lead = Array.from({ length: 80 }, () => attachment('D:\\a', 1000))
    const { fs } = memFs({
      [file('D--a', `${SID1}.jsonl`)]: { text: jsonl(...lead, user('D:\\a', 'late'), { type: 'last-prompt', lastPrompt: 'go on' }), mtimeMs: 2 },
      [file('D--a', `${SID2}.jsonl`)]: { text: jsonl(attachment('D:\\a')), mtimeMs: 1 }
    })
    expect(await new SessionHistory(ROOT, fs).list(10)).toEqual([
      { id: SID1, cwd: 'D:\\a', title: null, firstPrompt: null, lastPrompt: 'go on', modifiedAt: 2 }
    ])
  })

  it('reuses what it read until a file changes', async () => {
    const files = {
      [file('D--a', `${SID1}.jsonl`)]: { text: jsonl(user('D:\\a', 'a')), mtimeMs: 1 },
      [file('D--a', `${SID2}.jsonl`)]: { text: jsonl(user('D:\\a', 'b')), mtimeMs: 2 }
    }
    const { fs, reads } = memFs(files)
    const h = new SessionHistory(ROOT, fs)
    await h.list(10)
    const first = reads.length
    await h.list(10)
    expect(reads).toHaveLength(first)
    files[file('D--a', `${SID1}.jsonl`)] = { text: jsonl(user('D:\\a', 'a'), { type: 'ai-title', aiTitle: 'Changed' }), mtimeMs: 5 }
    const list = await h.list(10)
    expect(list[0]).toMatchObject({ id: SID1, title: 'Changed' })
    expect(reads.slice(first).every((r) => r.startsWith(file('D--a', `${SID1}.jsonl`)))).toBe(true)
  })

  it('a missing projects folder gives an empty list; an unreadable file is skipped', async () => {
    expect(await new SessionHistory(join('C:', 'nowhere'), memFs({}).fs).list(10)).toEqual([])
    const bad = file('D--a', `${SID1}.jsonl`)
    const { fs } = memFs({
      [bad]: { text: jsonl(user('D:\\a', 'a')), mtimeMs: 2 },
      [file('D--a', `${SID2}.jsonl`)]: { text: jsonl(user('D:\\a', 'b')), mtimeMs: 1 }
    }, [bad])
    expect((await new SessionHistory(ROOT, fs).list(10)).map((s) => s.id)).toEqual([SID2])
  })

  it('a first message longer than both windows with nothing before it: the folder comes from the tail, mapped back to the project folder', async () => {
    // a pasted screenshot: the user line carries cwd only after its huge message
    const image = { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { data: 'i'.repeat(TAIL_BYTES + 50_000) } }, { type: 'text', text: 'what is this' }] }, cwd: 'D:\\a', entrypoint: 'cli', isSidechain: false }
    // later entries run in a subfolder the conversation moved to
    const text = jsonl(image, attachment('D:\\a\\sub'), { type: 'last-prompt', lastPrompt: 'what is this' })
    const { fs } = memFs({ [file('D--a', `${SID1}.jsonl`)]: { text, mtimeMs: 7 } })
    expect(await new SessionHistory(ROOT, fs).list(10)).toEqual([
      { id: SID1, cwd: 'D:\\a', title: null, firstPrompt: null, lastPrompt: 'what is this', modifiedAt: 7 }
    ])
  })

  it('a tail folder outside the project folder is used as it is; a claude -p run found only by its tail is skipped', async () => {
    const image = (entrypoint: string): object => ({ type: 'user', message: { role: 'user', content: 'x'.repeat(TAIL_BYTES + 50_000) }, cwd: 'E:\\elsewhere', entrypoint, isSidechain: false })
    const { fs } = memFs({
      [file('D--a', `${SID1}.jsonl`)]: { text: jsonl(image('cli'), attachment('E:\\elsewhere'), { type: 'last-prompt', lastPrompt: 'go' }), mtimeMs: 2 },
      [file('D--a', `${SID2}.jsonl`)]: { text: jsonl(image('sdk-cli'), { ...attachment('E:\\elsewhere'), entrypoint: 'sdk-cli' }, { type: 'last-prompt', lastPrompt: 'go' }), mtimeMs: 1 }
    })
    const list = await new SessionHistory(ROOT, fs).list(10)
    expect(list.map((s) => [s.id, s.cwd])).toEqual([[SID1, 'E:\\elsewhere']])
  })
})
