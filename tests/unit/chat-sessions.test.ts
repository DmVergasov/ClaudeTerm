import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatSessions } from '../../src/main/chat/chat-sessions'

describe('ChatSessions', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-sessions-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the newest 2000 ids across a reload', () => {
    const file = join(dir, 'chat-sessions.json')
    const ids = Array.from({ length: 2001 }, () => randomUUID())
    const sessions = new ChatSessions(file)
    for (const id of ids) sessions.add(id)

    const reloaded = new ChatSessions(file)
    expect(reloaded.has(ids[0])).toBe(false)
    expect(reloaded.has(ids[1])).toBe(true)
    expect(reloaded.has(ids[2000])).toBe(true)
  })

  it('adding the newest id again writes nothing', () => {
    const file = join(dir, 'chat-sessions.json')
    const id = randomUUID()
    const sessions = new ChatSessions(file)
    sessions.add(id)

    // a write would put the list back over this: the file keeps what the test left in it
    writeFileSync(file, JSON.stringify([id, 'left-by-the-test']))
    sessions.add(id)
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify([id, 'left-by-the-test']))
  })
})
