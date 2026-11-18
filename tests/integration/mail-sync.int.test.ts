import { afterEach, describe, expect, it } from 'vitest'
import { MailSync, type MailAccept } from '../../src/main/mail/mail-sync'
import { MailStore } from '../../src/main/mail/mail-store'
import type { HelloMessage, Message } from '../../src/main/sync/wire'
import type { MailRecord } from '../../src/shared/mail'
import { closeLinkPairs, linkPair, tempDir, until } from '../fixtures/sync'

const NOW = 1700000000000
const DEV_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const DEV_B = '9a1e2f3c-4d5b-4e6f-8a7b-1c2d3e4f5a6b'
const DEV_C = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const SES_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SES_B = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const SES_C = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f'
const ACCEPT_A: MailAccept = { on: true, wakes: true, claude: '2.1.287' }
const ACCEPT_B: MailAccept = { on: false, wakes: false, claude: null }

let seq = 0
const newId = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

/** a message from A's session to B's, unless over says otherwise */
function record(over: Partial<MailRecord> = {}): MailRecord {
  return {
    v: 1,
    id: newId(),
    from: { device: DEV_A, session: SES_A, name: 'Parser' },
    to: { device: DEV_B, session: SES_B, name: 'Reviewer' },
    replyTo: null,
    text: 'Ready for review.',
    sentAt: NOW,
    delivered: false,
    read: false,
    ...over
  }
}

function store(): MailStore {
  return MailStore.open({ dir: tempDir('mail-sync'), now: () => NOW, debounceMs: 100000 })
}

function helloOf(id: string, mail = true, coord = true, words = true, questions = true): HelloMessage {
  return { t: 'hello', v: 1, id, name: 'Device', platform: 'linux', port: 0, addresses: [], reachedYou: null, ...(mail ? { mail: 1 as const } : {}), ...(coord ? { coord: 1 as const } : {}), ...(words ? { words: 1 as const } : {}), ...(questions ? { questions: 1 as const } : {}) }
}

const syncs: MailSync[] = []

function sync(s: MailStore, accept: MailAccept = ACCEPT_A, haveChunk?: number): MailSync {
  const m = new MailSync({ store: s, accept: () => accept, haveChunk })
  syncs.push(m)
  return m
}

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(async () => {
  for (const m of syncs.splice(0)) m.close()
  await closeLinkPairs()
})

describe('mail sync over the device links', () => {
  it('on attach both sides send mail-accept and their digest, and each gets what it lacked', async () => {
    const sa = store()
    const sb = store()
    const r1 = record()
    const r2 = record({ from: { device: DEV_B, session: SES_B, name: 'Reviewer' }, to: { device: DEV_A, session: SES_A, name: 'Parser' } })
    sa.add(r1)
    sb.add(r2)
    const a = sync(sa, ACCEPT_A)
    const b = sync(sb, ACCEPT_B)
    const { client, server } = await linkPair()
    a.attach(client, helloOf(DEV_B))
    b.attach(server, helloOf(DEV_A))

    await until(() => sa.get(r2.id) !== undefined && sb.get(r1.id) !== undefined)
    expect(sa.get(r1.id)).toEqual(r1)
    expect(sa.get(r2.id)).toEqual(r2)
    expect(sb.get(r1.id)).toEqual(r1)
    expect(sb.get(r2.id)).toEqual(r2)
  })

  it('a record added or marked after linking reaches the other side at once', async () => {
    const sa = store()
    const sb = store()
    const a = sync(sa)
    const b = sync(sb, ACCEPT_B)
    const { client, server } = await linkPair()
    a.attach(client, helloOf(DEV_B))
    b.attach(server, helloOf(DEV_A))
    await until(() => a.acceptOf(DEV_B) !== null && b.acceptOf(DEV_A) !== null)

    const r = record()
    sa.add(r)
    await until(() => sb.get(r.id) !== undefined, 1000)
    sa.mark([r.id], 'read')
    await until(() => sb.get(r.id)?.read === true, 1000)
  })

  it('a record that came from one link is relayed to the other links, not back', async () => {
    const sa = store()
    const sb = store()
    const sc = store()
    const a = sync(sa)
    const b = sync(sb)
    const c = sync(sc)
    const ab = await linkPair()
    const bc = await linkPair()
    a.attach(ab.client, helloOf(DEV_B))
    b.attach(ab.server, helloOf(DEV_A))
    b.attach(bc.client, helloOf(DEV_C))
    c.attach(bc.server, helloOf(DEV_B))
    await until(() => a.acceptOf(DEV_B) !== null && b.acceptOf(DEV_A) !== null && b.acceptOf(DEV_C) !== null && c.acceptOf(DEV_B) !== null)
    await settle()

    const heard: Message[] = []
    ab.client.on('message', (m: Message) => heard.push(m))
    const r = record({ to: { device: DEV_C, session: SES_C, name: 'Tester' } })
    sa.add(r)
    await until(() => sc.get(r.id) !== undefined)
    await settle()
    expect(sb.get(r.id)).toEqual(r)
    // B took the record in from A and passed it on to C, and did not send it back to A
    expect(heard.filter((m) => m.t === 'mail-records')).toEqual([])
  })

  it('records with a null device are never sent', async () => {
    const sa = store()
    const sb = store()
    const shared = record()
    const local = record({ from: { device: null, session: SES_A, name: 'Local' } })
    sa.add(shared)
    sa.add(local)
    const a = sync(sa)
    const b = sync(sb)
    const { client, server } = await linkPair()
    a.attach(client, helloOf(DEV_B))
    b.attach(server, helloOf(DEV_A))
    await until(() => sb.get(shared.id) !== undefined)

    const later = record({ to: { device: null, session: SES_B, name: 'Reviewer' } })
    sa.add(later)
    sa.mark([local.id], 'read')
    await settle()
    expect(sb.get(local.id)).toBeUndefined()
    expect(sb.get(later.id)).toBeUndefined()
  })

  it('a peer whose hello has no mail gets no mail message, and its link stays open', async () => {
    const sa = store()
    sa.add(record())
    const a = sync(sa)
    const { client, server } = await linkPair()
    const heard: Message[] = []
    server.on('message', (m: Message) => heard.push(m))
    const closed: string[] = []
    client.on('close', (reason: string) => closed.push(reason))

    a.attach(client, helloOf(DEV_B, false))
    sa.add(record())
    await settle()
    expect(heard.filter((m) => m.t.startsWith('mail-'))).toEqual([])
    expect(closed).toEqual([])
    expect(client.send({ t: 'ping' })).toBe(true)
  })

  it('acceptOf reports the peer accept and null after its link closes; announce sends the new accept', async () => {
    const sa = store()
    const sb = store()
    let acceptB: MailAccept = ACCEPT_B
    const a = sync(sa)
    const b = new MailSync({ store: sb, accept: () => acceptB })
    syncs.push(b)
    const { client, server } = await linkPair()
    a.attach(client, helloOf(DEV_B))
    b.attach(server, helloOf(DEV_A))
    await until(() => a.acceptOf(DEV_B) !== null)
    expect(a.acceptOf(DEV_B)).toEqual(ACCEPT_B)

    acceptB = { on: true, wakes: true, claude: '2.1.300' }
    b.announce()
    await until(() => a.acceptOf(DEV_B)?.on === true)
    expect(a.acceptOf(DEV_B)).toEqual({ on: true, wakes: true, claude: '2.1.300' })

    client.close('test')
    expect(a.acceptOf(DEV_B)).toBeNull()
    expect(a.acceptOf(DEV_C)).toBeNull()
  })

  it('after close nothing more is sent or taken in', async () => {
    const sa = store()
    const sb = store()
    const a = sync(sa)
    const b = sync(sb, ACCEPT_B)
    const { client, server } = await linkPair()
    a.attach(client, helloOf(DEV_B))
    b.attach(server, helloOf(DEV_A))
    await until(() => a.acceptOf(DEV_B) !== null)

    a.close()
    const r = record()
    sa.add(r)
    await settle()
    expect(sb.get(r.id)).toBeUndefined()
  })

  it('a digest sent in chunks is answered once: each record the peer lacks arrives exactly once', async () => {
    const sa = store()
    const sb = store()
    const lacking = [1, 2, 3, 4, 5].map(() => record())
    for (const r of lacking) sa.add(r)
    const held = [1, 2, 3].map(() => record({ from: { device: DEV_B, session: SES_B, name: 'Reviewer' }, to: { device: DEV_A, session: SES_A, name: 'Parser' } }))
    for (const r of held) sb.add(r)
    const a = sync(sa, ACCEPT_A, 2)
    const b = sync(sb, ACCEPT_B, 2)
    const { client, server } = await linkPair()
    const heard: string[] = []
    server.on('message', (m: Message) => {
      if (m.t === 'mail-records') for (const r of m.records) heard.push(r.id)
    })
    a.attach(client, helloOf(DEV_B))
    b.attach(server, helloOf(DEV_A))
    await until(() => lacking.every((r) => sb.get(r.id) !== undefined) && held.every((r) => sa.get(r.id) !== undefined))
    await settle()
    expect(heard.sort()).toEqual(lacking.map((r) => r.id).sort())
  })

  it('a digest of more than 10 buffered chunks is dropped: nothing is sent for it', async () => {
    const sa = store()
    const sb = store()
    const lacking = record()
    sa.add(lacking)
    for (let i = 0; i < 12; i++) sb.add(record({ from: { device: DEV_B, session: SES_B, name: 'Reviewer' }, to: { device: DEV_A, session: SES_A, name: 'Parser' } }))
    const a = sync(sa, ACCEPT_A, 1)
    const b = sync(sb, ACCEPT_B, 1)
    const { client, server } = await linkPair()
    a.attach(client, helloOf(DEV_B))
    b.attach(server, helloOf(DEV_A))
    // A takes in the 12 records of B, which answers A's one-chunk digest
    await until(() => sa.all().length === 13)
    await settle()
    expect(sb.get(lacking.id)).toBeUndefined()
  })

  it('a backlog larger than 500 records reaches the other side in batches', async () => {
    const sa = store()
    const sb = store()
    for (let i = 0; i < 1200; i++) sa.add(record({ text: `message ${i}` }))
    const a = sync(sa)
    const b = sync(sb, ACCEPT_B)
    const { client, server } = await linkPair()
    a.attach(client, helloOf(DEV_B))
    b.attach(server, helloOf(DEV_A))
    await until(() => sb.all().length === 1200, 10000)
  })

  it('a record written after the attach and before the answer to the peer digest arrives after the records of the answer', async () => {
    const sa = store()
    // the peer lacks this record, so the answer to its digest carries it
    const old = record()
    sa.add(old)
    const a = sync(sa)
    const { client, server } = await linkPair()
    const heard: string[] = []
    server.on('message', (m: Message) => {
      if (m.t === 'mail-records') for (const r of m.records) heard.push(r.id)
    })
    a.attach(client, helloOf(DEV_B))
    // written while the peer's digest is still on its way
    const late = record()
    sa.add(late)
    server.send({ t: 'mail-have', have: [] })
    await until(() => heard.length >= 2)
    await settle()
    expect([...new Set(heard)]).toEqual([old.id, late.id])
  })
})

describe('coordinator records between devices', () => {
  it('a record with a kind goes only to a peer whose hello knows coordinator records; a message goes to every peer', async () => {
    const sa = store()
    const sb = store()
    const sc = store()
    const a = sync(sa)
    const b = sync(sb)
    const c = sync(sc)
    const ab = await linkPair()
    const ac = await linkPair()
    a.attach(ab.client, helloOf(DEV_B))
    a.attach(ac.client, helloOf(DEV_C, true, false))
    b.attach(ab.server, helloOf(DEV_A))
    c.attach(ac.server, helloOf(DEV_A))
    await until(() => a.acceptOf(DEV_B) !== null && a.acceptOf(DEV_C) !== null && b.acceptOf(DEV_A) !== null && c.acceptOf(DEV_A) !== null)
    await settle()

    const task = record({ kind: 'task', project: 'acme' })
    const attach = record({ kind: 'attach', project: 'acme', to: { device: DEV_C, session: SES_C, name: 'Tester' } })
    const message = record({ to: { device: DEV_C, session: SES_C, name: 'Tester' } })
    sa.add(task)
    sa.add(attach)
    sa.add(message)
    await until(() => sb.get(task.id) !== undefined && sb.get(attach.id) !== undefined && sc.get(message.id) !== undefined)
    await settle()
    expect(sb.get(task.id)).toEqual(task)
    expect(sb.get(attach.id)).toEqual(attach)
    expect(sb.get(message.id)).toEqual(message)
    expect(sc.get(message.id)).toEqual(message)
    expect(sc.get(attach.id)).toBeUndefined()
    expect(sc.get(task.id)).toBeUndefined()
  })

  it('the answer to a digest leaves out the records with a kind for a peer that does not know them', async () => {
    const sa = store()
    const sb = store()
    const task = record({ kind: 'task', project: 'acme' })
    const message = record()
    sa.add(task)
    sa.add(message)
    const a = sync(sa)
    const b = sync(sb)
    const { client, server } = await linkPair()
    a.attach(client, helloOf(DEV_B, true, false))
    b.attach(server, helloOf(DEV_A))

    await until(() => sb.get(message.id) !== undefined)
    await settle()
    expect(sb.get(message.id)).toEqual(message)
    expect(sb.get(task.id)).toBeUndefined()
  })

  it('records with a kind from a peer that does not know them are dropped; its messages are kept', async () => {
    const sa = store()
    const sb = store()
    const a = sync(sa)
    const b = sync(sb)
    const { client, server } = await linkPair()
    a.attach(client, helloOf(DEV_B, true, false))
    b.attach(server, helloOf(DEV_A))
    await until(() => a.acceptOf(DEV_B) !== null && b.acceptOf(DEV_A) !== null)
    await settle()

    const from = { device: DEV_B, session: SES_B, name: 'Reviewer' }
    const to = { device: DEV_A, session: SES_A, name: 'Parser' }
    const task = record({ kind: 'task', project: 'acme', from, to })
    const message = record({ from, to })
    sb.add(task)
    sb.add(message)
    await until(() => sa.get(message.id) !== undefined)
    await settle()
    expect(sa.get(message.id)).toEqual(message)
    expect(sa.get(task.id)).toBeUndefined()
  })

  it('knowsCoordinator is true for a linked peer with coord, false for one without, and false once the link closes', async () => {
    const a = sync(store())
    const knows = await linkPair()
    const plain = await linkPair()
    a.attach(knows.client, helloOf(DEV_B))
    a.attach(plain.client, helloOf(DEV_C, true, false))
    expect(a.knowsCoordinator(DEV_B)).toBe(true)
    expect(a.knowsCoordinator(DEV_C)).toBe(false)
    knows.client.close('test')
    expect(a.knowsCoordinator(DEV_B)).toBe(false)
  })

  it("a peer whose hello has no words gets no progress note and no task with the person's words; its other tasks still go", async () => {
    const sa = store()
    const sb = store()
    const task = record({ kind: 'task', project: 'acme' })
    const words = record({ kind: 'task', project: 'acme', words: 'Merge it into master.', context: 'Shall I merge feat/x?' })
    const progress = record({ kind: 'progress', replyTo: newId(), text: 'Waiting for the tests.' })
    sa.add(task)
    sa.add(words)
    sa.add(progress)
    const a = sync(sa)
    const b = sync(sb)
    const { client, server } = await linkPair()
    a.attach(client, helloOf(DEV_B, true, true, false))
    b.attach(server, helloOf(DEV_A))
    await until(() => sb.get(task.id) !== undefined)
    await settle()
    expect(sb.get(words.id)).toBeUndefined()
    expect(sb.get(progress.id)).toBeUndefined()
    // a record added later is relayed by the same rule
    const later = record({ kind: 'progress', replyTo: newId(), text: 'Still waiting.' })
    const plain = record({ kind: 'task', project: 'acme', text: 'Fix the parser.' })
    sa.add(later)
    sa.add(plain)
    await until(() => sb.get(plain.id) !== undefined)
    await settle()
    expect(sb.get(later.id)).toBeUndefined()
  })

  it('knowsWords is true for a linked peer whose hello has words, false for one without, and false once the link closes', async () => {
    const a = sync(store())
    const knows = await linkPair()
    const plain = await linkPair()
    a.attach(knows.client, helloOf(DEV_B))
    a.attach(plain.client, helloOf(DEV_C, true, true, false))
    expect(a.knowsWords(DEV_B)).toBe(true)
    expect(a.knowsWords(DEV_C)).toBe(false)
    knows.client.close('test')
    expect(a.knowsWords(DEV_B)).toBe(false)
  })

  it("a peer whose hello has no questions gets no question, answer or withdraw; its tasks and reports still go", async () => {
    const sa = store()
    const sb = store()
    const from = { device: DEV_A, session: SES_A, name: 'Parser' }
    const to = { device: DEV_B, session: SES_B, name: 'Reviewer' }
    const task = record({ kind: 'task', project: 'acme', from, to })
    const report = record({ kind: 'report', outcome: 'finished', replyTo: newId(), from, to })
    const question = record({ kind: 'question', replyTo: newId(), from, to })
    const answer = record({ kind: 'answer', replyTo: newId(), from, to })
    const withdraw = record({ kind: 'withdraw', replyTo: newId(), from, to })
    sa.add(task)
    sa.add(report)
    sa.add(question)
    sa.add(answer)
    sa.add(withdraw)
    const a = sync(sa)
    const b = sync(sb)
    const { client, server } = await linkPair()
    a.attach(client, helloOf(DEV_B, true, true, true, false))
    b.attach(server, helloOf(DEV_A))
    await until(() => sb.get(task.id) !== undefined && sb.get(report.id) !== undefined)
    await settle()
    expect(sb.get(question.id)).toBeUndefined()
    expect(sb.get(answer.id)).toBeUndefined()
    expect(sb.get(withdraw.id)).toBeUndefined()
    // a record added later is relayed by the same rule
    const later = record({ kind: 'question', replyTo: newId(), from, to })
    const plain = record({ kind: 'task', project: 'acme', from, to, text: 'Fix the parser.' })
    sa.add(later)
    sa.add(plain)
    await until(() => sb.get(plain.id) !== undefined)
    await settle()
    expect(sb.get(later.id)).toBeUndefined()
  })

  it('knowsQuestions is true for a linked peer with questions, false for one without, and false once the link closes', async () => {
    const a = sync(store())
    const knows = await linkPair()
    const plain = await linkPair()
    a.attach(knows.client, helloOf(DEV_B))
    a.attach(plain.client, helloOf(DEV_C, true, true, true, false))
    expect(a.knowsQuestions(DEV_B)).toBe(true)
    expect(a.knowsQuestions(DEV_C)).toBe(false)
    knows.client.close('test')
    expect(a.knowsQuestions(DEV_B)).toBe(false)
  })
})
