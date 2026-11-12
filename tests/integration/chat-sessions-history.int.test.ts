import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChatSessions } from '../../src/main/chat/chat-sessions'
import { nodeHistoryFs, SessionHistory } from '../../src/main/session-history'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

// a transcript Claude Code writes for a chat ClaudeTerm started: its entrypoint is the SDK's, not a terminal's
describe('Recent sessions of the chats ClaudeTerm started', () => {
  it('an sdk-ts transcript is hidden until its id is known as a chat, then listed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-chat-history-'))
    const folder = join(root, 'projects', 'D--work')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd: 'D:\\work', entrypoint: 'sdk-ts', isSidechain: false, message: { role: 'user', content: 'hello' } }) + '\n')
    const file = join(root, 'chat-sessions.json')

    const history = new SessionHistory(join(root, 'projects'), nodeHistoryFs, (id) => new ChatSessions(file).has(id))
    expect(await history.list(10)).toEqual([])

    new ChatSessions(file).add(SID)
    expect((await history.list(10)).map((s) => s.id)).toEqual([SID])
  })

  it('the chat ids are kept on disk: a new run lists the chat too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-chat-history-'))
    const folder = join(root, 'projects', 'D--work')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd: 'D:\\work', entrypoint: 'sdk-ts', isSidechain: false, message: { role: 'user', content: 'hi' } }) + '\n')
    const file = join(root, 'chat-sessions.json')
    new ChatSessions(file).add(SID)

    const history = new SessionHistory(join(root, 'projects'), nodeHistoryFs, (id) => new ChatSessions(file).has(id))
    expect((await history.list(10)).map((s) => s.id)).toEqual([SID])
  })
})
