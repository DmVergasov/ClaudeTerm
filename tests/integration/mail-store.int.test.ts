import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MailStore } from '../../src/main/mail/mail-store'
import { MAIL_KEEP_MS, type MailRecord } from '../../src/shared/mail'

const DEV_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const DEV_B = '9a1e2f3c-4d5b-4e6f-8a7b-1c2d3e4f5a6b'
const SES_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SES_B = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const NOW = 1700000000000
const FILE = 'agent-messages.json'

const dir = (): string => mkdtempSync(join(tmpdir(), 'ct-mail-'))

let seq = 0
const id = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

const record = (over: Partial<MailRecord> = {}): MailRecord => ({
  v: 1,
  id: id(),
  from: { device: DEV_A, session: SES_A, name: 'Parser' },
  to: { device: DEV_B, session: SES_B, name: 'Reviewer' },
  replyTo: null,
  text: 'Ready for review.',
  sentAt: NOW,
  delivered: false,
  read: false,
  ...over
})

const onDisk = (d: string): { version: number; records: MailRecord[] } => JSON.parse(readFileSync(join(d, FILE), 'utf8'))

describe('MailStore', () => {
  it('a message added is on disk in agent-messages.json after flush and comes back on open', () => {
    const d = dir()
    const store = MailStore.open({ dir: d, now: () => NOW, debounceMs: 100000 })
    const r = record()
    store.add(r)
    expect(existsSync(join(d, FILE))).toBe(false)
    store.flush()
    expect(onDisk(d)).toEqual({ version: 1, records: [r] })
    expect(MailStore.open({ dir: d, now: () => NOW }).get(r.id)).toEqual(r)
  })

  it('merge adds new records and raises flags; it returns only what changed', () => {
    const store = MailStore.open({ dir: dir(), now: () => NOW, debounceMs: 100000 })
    const r = record()
    expect(store.merge([r], { link: 'peer' })).toEqual([r])
    expect(store.merge([r], { link: 'peer' })).toEqual([])

    const changed = store.merge([{ ...r, read: true, delivered: true }], { link: 'peer' })
    expect(changed).toEqual([{ ...r, read: true, delivered: true }])
    expect(store.get(r.id)).toEqual({ ...r, read: true, delivered: true })
  })

  it('onChange returns a function that stops the listener', () => {
    const store = MailStore.open({ dir: dir(), now: () => NOW, debounceMs: 100000 })
    const seen: string[] = []
    const off = store.onChange((changed) => seen.push(...changed.map((r) => r.id)))
    off()
    store.add(record())
    expect(seen).toEqual([])
  })

  it('merge drops a record sent more than 24 hours ahead of the clock, and keeps one 1 hour ahead', () => {
    const store = MailStore.open({ dir: dir(), now: () => NOW, debounceMs: 100000 })
    const far = record({ sentAt: NOW + 25 * 60 * 60 * 1000 })
    const near = record({ sentAt: NOW + 60 * 60 * 1000 })
    expect(store.merge([far, near], { link: 'peer' })).toEqual([near])
    expect(store.get(far.id)).toBeUndefined()
    expect(store.get(near.id)).toEqual(near)
  })

  it('merge drops records older than 30 days, and prune removes them from disk', () => {
    const d = dir()
    let clock = NOW
    const store = MailStore.open({ dir: d, now: () => clock, debounceMs: 100000 })
    const old = record({ sentAt: NOW - MAIL_KEEP_MS - 1 })
    const fresh = record({ sentAt: NOW - 1000 })
    expect(store.merge([old, fresh], { link: 'peer' })).toEqual([fresh])
    expect(store.get(old.id)).toBeUndefined()
    store.flush()
    expect(onDisk(d).records).toEqual([fresh])

    // the clock moves on until the stored record is older than 30 days
    clock = NOW + MAIL_KEEP_MS + 1000
    store.prune()
    expect(store.get(fresh.id)).toBeUndefined()
    expect(onDisk(d).records).toEqual([])
  })

  it('digest leaves out records with a null device; missingFor returns what the peer lacks or holds with fewer flags', () => {
    const store = MailStore.open({ dir: dir(), now: () => NOW, debounceMs: 100000 })
    const shared = record({ delivered: true })
    const local = record({ from: { device: null, session: SES_A, name: 'Local' } })
    const unread = record()
    store.add(shared)
    store.add(local)
    store.add(unread)
    const ids = (rs: MailRecord[]): string[] => rs.map((r) => r.id)

    const digest = store.digest()
    expect(digest).toEqual([
      [shared.id, 1],
      [unread.id, 0]
    ])

    // the peer holds nothing: both shareable records are missing
    expect(ids(store.missingFor([]))).toEqual([shared.id, unread.id])
    // the peer holds the unread record: only the one it lacks is missing
    expect(ids(store.missingFor([[unread.id, 0]]))).toEqual([shared.id])
    // the peer holds shared with fewer flags (none): it is missing too
    expect(ids(store.missingFor([[shared.id, 0], [unread.id, 0]]))).toEqual([shared.id])
    // the peer holds shared with the same flags: nothing is missing
    expect(ids(store.missingFor([[shared.id, 1], [unread.id, 0]]))).toEqual([])

    store.mark([shared.id], 'read')
    expect(ids(store.missingFor([[shared.id, 1], [unread.id, 0]]))).toEqual([shared.id])
    expect(ids(store.missingFor([[shared.id, 3], [unread.id, 0]]))).toEqual([])
  })

  it('a corrupt file is moved aside and the store opens empty', () => {
    const d = dir()
    writeFileSync(join(d, FILE), '{ not json', 'utf8')
    const store = MailStore.open({ dir: d, now: () => NOW, debounceMs: 100000 })
    expect(store.all()).toEqual([])
    const aside = readdirSync(d).filter((f) => f.startsWith('agent-messages.json.corrupt-'))
    expect(aside.length).toBe(1)
    expect(existsSync(join(d, FILE))).toBe(false)
  })

  it('records failing checkMailRecord in the file are skipped on load', () => {
    const d = dir()
    const good = record()
    const bad = { ...record(), text: '' }
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, FILE), JSON.stringify({ version: 1, records: [good, bad] }), 'utf8')
    const store = MailStore.open({ dir: d, now: () => NOW, debounceMs: 100000 })
    expect(store.all()).toEqual([good])
  })

  it('onChange reports local adds with origin local and merges with the origin passed', () => {
    const store = MailStore.open({ dir: dir(), now: () => NOW, debounceMs: 100000 })
    const seen: Array<{ ids: string[]; origin: unknown }> = []
    store.onChange((changed, origin) => seen.push({ ids: changed.map((r) => r.id), origin }))

    const local = record()
    store.add(local)
    const remote = record()
    store.merge([remote], { link: 'peer-1' })
    expect(seen).toEqual([
      { ids: [local.id], origin: 'local' },
      { ids: [remote.id], origin: { link: 'peer-1' } }
    ])
  })
})
