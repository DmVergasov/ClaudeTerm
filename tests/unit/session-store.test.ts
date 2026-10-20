import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSnapshot, SessionStore } from '../../src/main/session-store'
import type { SessionSnapshot, SessionSnapshotTab } from '../../src/shared/types'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const claudeTab: SessionSnapshotTab = { kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\x', title: null, claudeSessionId: SID, account: null, muted: false }
const shellTab: SessionSnapshotTab = { kind: 'shell', profile: 'Git Bash', cwd: 'D:\\y', title: 'build', claudeSessionId: null, account: null, muted: true }
const snap = (tabs: SessionSnapshotTab[]): SessionSnapshot => ({ version: 1, savedAt: '2026-10-05T10:00:00.000Z', tabs })
const newDir = (): string => mkdtempSync(join(tmpdir(), 'ct-sess-'))

afterEach(() => { vi.useRealTimers() })

describe('parseSnapshot', () => {
  it('round-trips a valid snapshot', () => {
    expect(parseSnapshot(JSON.stringify(snap([claudeTab, shellTab])))).toEqual(snap([claudeTab, shellTab]))
  })

  it('drops non-UUID session ids and rejects malformed files', () => {
    expect(parseSnapshot(JSON.stringify(snap([{ ...claudeTab, claudeSessionId: 'x; calc' }])))?.tabs[0].claudeSessionId).toBeNull()
    expect(parseSnapshot('{')).toBeNull()
    expect(parseSnapshot(JSON.stringify({ version: 2, savedAt: 'x', tabs: [] }))).toBeNull()
    expect(parseSnapshot(JSON.stringify(snap([{ ...shellTab, kind: 'evil' as 'shell' }])))).toBeNull()
  })

  it('reads the account of a claude tab; a snapshot from before accounts restores on the main account', () => {
    expect(parseSnapshot(JSON.stringify(snap([{ ...claudeTab, account: 'acc-1' }])))?.tabs[0].account).toBe('acc-1')
    const old = { version: 1, savedAt: 'x', tabs: [{ kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\x', title: null, claudeSessionId: SID }] }
    expect(parseSnapshot(JSON.stringify(old))?.tabs[0].account).toBeNull()
    expect(parseSnapshot(JSON.stringify(snap([{ ...claudeTab, account: 5 as unknown as string }])))?.tabs[0].account).toBeNull()
    expect(parseSnapshot(JSON.stringify(snap([{ ...claudeTab, account: 'x'.repeat(65) }])))?.tabs[0].account).toBeNull()
    expect(parseSnapshot(JSON.stringify(snap([{ ...shellTab, account: 'acc-1' }])))?.tabs[0].account).toBeNull()
  })

  it('reads whether a tab was muted; a snapshot from before muting restores the tab with its sound', () => {
    expect(parseSnapshot(JSON.stringify(snap([{ ...claudeTab, muted: true }])))?.tabs[0].muted).toBe(true)
    const old = { version: 1, savedAt: 'x', tabs: [{ kind: 'shell', profile: 'Git Bash', cwd: 'D:\\y', title: null, claudeSessionId: null }] }
    expect(parseSnapshot(JSON.stringify(old))?.tabs[0].muted).toBe(false)
    expect(parseSnapshot(JSON.stringify(snap([{ ...claudeTab, muted: 'yes' as unknown as boolean }])))?.tabs[0].muted).toBe(false)
  })
})

describe('SessionStore', () => {
  it('rotateOnStartup moves a non-empty state to previous', () => {
    const dir = newDir()
    const s = new SessionStore(dir)
    writeFileSync(s.statePath, JSON.stringify(snap([claudeTab])))
    expect(s.rotateOnStartup()).toEqual(snap([claudeTab]))
    expect(existsSync(s.statePath)).toBe(false)
    expect(existsSync(s.previousPath)).toBe(true)
  })

  it('an empty state does not overwrite an existing previous', () => {
    const dir = newDir()
    const s = new SessionStore(dir)
    writeFileSync(s.previousPath, JSON.stringify(snap([claudeTab])))
    writeFileSync(s.statePath, JSON.stringify(snap([])))
    expect(s.rotateOnStartup()).toEqual(snap([claudeTab]))
  })

  it('a shell-only state does not replace an existing previous', () => {
    const s = new SessionStore(newDir())
    writeFileSync(s.previousPath, JSON.stringify(snap([claudeTab])))
    writeFileSync(s.statePath, JSON.stringify(snap([shellTab])))
    expect(s.rotateOnStartup()).toEqual(snap([claudeTab]))
  })

  it('a state with a claude tab and session id replaces the previous', () => {
    const s = new SessionStore(newDir())
    writeFileSync(s.previousPath, JSON.stringify(snap([shellTab])))
    writeFileSync(s.statePath, JSON.stringify(snap([shellTab, claudeTab])))
    expect(s.rotateOnStartup()).toEqual(snap([shellTab, claudeTab]))
    expect(existsSync(s.statePath)).toBe(false)
  })

  it('a claude tab without a session id does not replace the previous', () => {
    const s = new SessionStore(newDir())
    writeFileSync(s.previousPath, JSON.stringify(snap([claudeTab])))
    writeFileSync(s.statePath, JSON.stringify(snap([{ ...claudeTab, claudeSessionId: null }])))
    expect(s.rotateOnStartup()).toEqual(snap([claudeTab]))
  })

  it('a corrupt state is not rotated and is reported', () => {
    const dir = newDir()
    const onError = vi.fn()
    const s = new SessionStore(dir, { onError })
    writeFileSync(s.previousPath, JSON.stringify(snap([shellTab])))
    writeFileSync(s.statePath, '{broken')
    expect(s.rotateOnStartup()).toEqual(snap([shellTab]))
    expect(onError).toHaveBeenCalled()
  })

  it('after an update any non-empty state is rotated, shell-only included', () => {
    const s = new SessionStore(newDir())
    writeFileSync(s.previousPath, JSON.stringify(snap([claudeTab])))
    writeFileSync(s.statePath, JSON.stringify(snap([shellTab])))
    expect(s.rotateOnStartup({ afterUpdate: true })).toEqual(snap([shellTab]))
    expect(existsSync(s.statePath)).toBe(false)
  })

  it('after an update an empty state does not revive an older previous session', () => {
    const s = new SessionStore(newDir())
    writeFileSync(s.previousPath, JSON.stringify(snap([claudeTab])))
    writeFileSync(s.statePath, JSON.stringify(snap([])))
    expect(s.rotateOnStartup({ afterUpdate: true })).toBeNull()
    const none = new SessionStore(newDir())
    writeFileSync(none.previousPath, JSON.stringify(snap([claudeTab])))
    expect(none.rotateOnStartup({ afterUpdate: true })).toBeNull()
  })

  it('nothing saved → no previous', () => {
    expect(new SessionStore(newDir()).rotateOnStartup()).toBeNull()
  })

  it('saveNow writes atomically', () => {
    const dir = newDir()
    const s = new SessionStore(dir, { now: () => new Date('2026-10-05T10:00:00.000Z') })
    s.saveNow([shellTab])
    expect(JSON.parse(readFileSync(s.statePath, 'utf8'))).toEqual(snap([shellTab]))
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('scheduleSave debounces and flush writes the latest tabs immediately', () => {
    vi.useFakeTimers()
    const s = new SessionStore(newDir(), { debounceMs: 500 })
    s.scheduleSave([claudeTab])
    s.scheduleSave([shellTab])
    expect(existsSync(s.statePath)).toBe(false)
    vi.advanceTimersByTime(500)
    expect(parseSnapshot(readFileSync(s.statePath, 'utf8'))?.tabs).toEqual([shellTab])
    s.scheduleSave([claudeTab])
    s.flush()
    expect(parseSnapshot(readFileSync(s.statePath, 'utf8'))?.tabs).toEqual([claudeTab])
  })

  it('clearPrevious removes the previous snapshot', () => {
    const s = new SessionStore(newDir())
    writeFileSync(s.previousPath, JSON.stringify(snap([claudeTab])))
    s.clearPrevious()
    expect(s.readPrevious()).toBeNull()
  })
})
