import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { accountSessionStore } from '../../src/main/transcript-move'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

// a sign-in account's conversation: its transcript is in that account's folder only, not in the folder the SDK reads by default
describe('the history of a sign-in account is read from its own folder', () => {
  const roots: string[] = []
  const config = process.env.CLAUDE_CONFIG_DIR
  // the SDK's own default folder is a temp folder here, never the real ~/.claude
  beforeEach(() => {
    const main = mkdtempSync(join(tmpdir(), 'ct-account-main-'))
    roots.push(main)
    process.env.CLAUDE_CONFIG_DIR = main
  })
  afterEach(() => {
    if (config === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = config
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  it('the SDK reads the messages through the account store, from the account projects folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-account-history-'))
    roots.push(root)
    const projects = join(root, 'work', 'projects')
    const project = join(projects, 'D--work')
    mkdirSync(project, { recursive: true })
    const user = { type: 'user', uuid: '11111111-1111-4111-8111-111111111111', parentUuid: null, sessionId: SID, cwd: 'D:\\work', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'Where is the log?' } }
    const reply = { type: 'assistant', uuid: '22222222-2222-4222-8222-222222222222', parentUuid: user.uuid, sessionId: SID, cwd: 'D:\\work', timestamp: '2026-11-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'In the logs folder.' }] } }
    writeFileSync(join(project, `${SID}.jsonl`), [user, reply].map((l) => JSON.stringify(l)).join('\n') + '\n')

    const messages = await getSessionMessages(SID, { dir: 'D:\\work', includeSystemMessages: true, sessionStore: accountSessionStore(projects) })
    expect(messages.map((m) => m.type)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(messages[1].message)).toContain('In the logs folder.')
  })

  it('a long conversation keeps its history: a transcript over 16 MiB is read too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-account-history-'))
    roots.push(root)
    const projects = join(root, 'work', 'projects')
    const project = join(projects, 'D--work')
    mkdirSync(project, { recursive: true })
    // a conversation of long answers, as a session of weeks has: its transcript is past the 16 MiB a config file may have
    const entries: Record<string, unknown>[] = []
    let parent: string | null = null
    const long = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 18; i++) {
      const askId = `00000000-0000-4000-8000-${String(i * 2).padStart(12, '0')}`
      const answerId = `00000000-0000-4000-8000-${String(i * 2 + 1).padStart(12, '0')}`
      entries.push(
        { type: 'user', uuid: askId, parentUuid: parent, sessionId: SID, cwd: 'D:\\work', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: `step ${i}` } },
        { type: 'assistant', uuid: answerId, parentUuid: askId, sessionId: SID, cwd: 'D:\\work', timestamp: '2026-11-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `${long} ${i}` }] } }
      )
      parent = answerId
    }
    writeFileSync(join(project, `${SID}.jsonl`), entries.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const messages = await getSessionMessages(SID, { dir: 'D:\\work', includeSystemMessages: true, sessionStore: accountSessionStore(projects) })
    expect(messages).toHaveLength(36)
    expect(JSON.stringify(messages[0].message)).toContain('step 0')
    expect(JSON.stringify(messages[35].message)).toContain(' 17')
  })

  it('a session the account does not hold reads as no messages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-account-history-'))
    roots.push(root)
    const projects = join(root, 'work', 'projects')
    mkdirSync(projects, { recursive: true })
    const messages = await getSessionMessages(SID, { dir: 'D:\\work', includeSystemMessages: true, sessionStore: accountSessionStore(projects) })
    expect(messages).toEqual([])
  })
})
