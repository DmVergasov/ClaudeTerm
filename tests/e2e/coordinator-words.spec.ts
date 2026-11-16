import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { HUB_TEXT } from '../../src/main/coordinator/coordinator-hub'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { PERSON_WORDS_ANSWER, PERSON_WORDS_CONTEXT, PERSON_WORDS_HEAD, PERSON_WORDS_NOTE } from '../../src/shared/report-wake'
import { hasMailWatcher, refOf, startSession, waitForMail } from './agent-mail'
import { coord, coordinatorTranscript, done, makeCoordinator, personSays, stillWaiting, terminalStandInApp, turnOf, typedHas, typedLines, within } from './coordinator-helpers'
import { seenToasts, watchToasts } from './helpers'

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The app of the terminal view, with two Claude tabs in one repository on the stand-in, which draws Claude Code's empty prompt and
 * logs each line typed. Tab 1 is the coordinator: its session started with a transcript whose last entry asks "Shall I merge feat/x
 * into master?". Tab 2's session is attached to it. `say` is the person writing to the coordinator.
 */
async function wordsApp() {
  const l = await terminalStandInApp()
  const { page, pipeName, tab1, tab2 } = l
  const sid1 = randomUUID()
  const sid2 = randomUUID()
  const transcript = await coordinatorTranscript(pipeName, tab1, sid1, 'Shall I merge feat/x into master?')
  expect(await startSession(pipeName, tab2, sid2)).toEqual({ ok: true })
  // agent messages wait for the version probe: the tab settings file gets the mail watcher once it has answered
  await expect.poll(() => hasMailWatcher(l.dataDir), { timeout: 15_000 }).toBe(true)
  expect(await makeCoordinator(page, tab1)).toMatchObject({ ok: true })
  expect(await coord(pipeName, tab1, { op: 'attach', session: refOf(sid2) })).toMatchObject({ ok: true })
  await watchToasts(page)
  const say = (text: string, o: { keys?: boolean } = {}): Promise<void> => personSays(page, tab1, transcript, text, o)
  return { ...l, sid1, sid2, say }
}

/** the coordinator passes the person's words to tab 2's session, with a task of its own */
const give = (t: { pipeName: string; tab1: string; sid2: string }, words: string) =>
  coord(t.pipeName, t.tab1, { op: 'message', session: refOf(t.sid2), text: 'Merge feat/x into master and push.', words })

test("the person's words go with the task: typed into the idle session's prompt under the coordinator's question, never to its watcher, with a toast; the report comes back", async () => {
  const t = await wordsApp()
  try {
    await t.say('Merge it into master.')
    // the session's watcher waits: the words still go to its prompt, and the watcher gets nothing
    const w2 = waitForMail(t.pipeName, t.tab2, t.sid2)
    w2.catch(() => {})
    expect(await coord(t.pipeName, t.tab1, { op: 'message', session: refOf(t.sid2), text: 'Merge feat/x into master and push.', words: 'Merge it into master.' }))
      .toMatchObject({ ok: true, info: expect.stringContaining("The person's words went to ") })
    await expect.poll(() => typedHas(t.standIn.log, PERSON_WORDS_ANSWER), { timeout: 15_000 }).toBe(true)
    const lines = typedLines(t.standIn.log)
    const order = [PERSON_WORDS_HEAD, PERSON_WORDS_NOTE, PERSON_WORDS_CONTEXT, '> Shall I merge feat/x into master?', PERSON_WORDS_ANSWER, '> Merge it into master.', 'Task from your coordinator, through ClaudeTerm:', '> Merge feat/x into master and push.']
      .map((text) => lines.findIndex((l) => l.includes(text)))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    await stillWaiting(w2, 1000)
    await expect.poll(() => seenToasts(t.page)).toContainEqual(expect.stringMatching(/^Your words went to .+: «Merge it into master\.»$/))

    // the report comes back as for any task
    const c = waitForMail(t.pipeName, t.tab1, t.sid1)
    c.catch(() => {})
    await turnOf(t.pipeName, t.tab2, t.sid2)
    await done(t.pipeName, t.tab2, t.sid2, { lastMessage: 'Merged and pushed.' })
    const report = await within(c, 15_000)
    expect(report.info).toContain('Report from a session attached to you, through ClaudeTerm: its task finished.')
    expect(report.info).toContain('> Merged and pushed.')
  } finally {
    await t.app.close()
  }
})

test("words that are not the person's latest message as they wrote it are refused, and nothing is typed", async () => {
  const t = await wordsApp()
  try {
    await t.say('Merge it into master.')
    expect(await give(t, 'Merge it into master!')).toEqual({ ok: false, error: HUB_TEXT.wordsNotPerson })

    // the person's message passes once; to the same session again it is refused
    expect(await give(t, 'Merge it into master.')).toMatchObject({ ok: true })
    await expect.poll(() => typedHas(t.standIn.log, '> Merge it into master.'), { timeout: 15_000 }).toBe(true)
    expect(await give(t, 'Merge it into master.')).toMatchObject({ ok: false, error: expect.stringMatching(/^This message of the person went to .+ already\./) })

    // once the person writes again, the earlier message can no longer be passed
    await t.say('Wait, run the e2e first.')
    expect(await give(t, 'Merge it into master.')).toEqual({ ok: false, error: HUB_TEXT.wordsNotLatest })

    // a prompt in the transcript that no key in the window typed is not the person's, and it still blocks the earlier ones
    await t.say('Push it as well.', { keys: false })
    expect(await give(t, 'Push it as well.')).toEqual({ ok: false, error: HUB_TEXT.wordsNotPerson })
    expect(await give(t, 'Wait, run the e2e first.')).toEqual({ ok: false, error: HUB_TEXT.wordsNotLatest })

    // the person's words block was typed exactly once
    await pause(2000)
    expect(typedLines(t.standIn.log).filter((l) => l.includes(PERSON_WORDS_ANSWER))).toHaveLength(1)
  } finally {
    await t.app.close()
  }
})

test("start_session with the person's words: the new session's first message is typed with them", async () => {
  const t = await wordsApp()
  try {
    await t.say('Write the release notes now.')
    const answer = coord(t.pipeName, t.tab1, { op: 'start', task: 'Write the release notes.', name: 'Release notes', folder: null, device: null, worktree: null, words: 'Write the release notes now.' })
    await expect.poll(() => t.page.evaluate(() => window.__ct!.tabIds().length)).toBe(3)
    const newTab = (await t.page.evaluate(() => window.__ct!.tabIds())).find((id) => id !== t.tab1 && id !== t.tab2)!
    const sid = randomUUID()
    expect(await startSession(t.pipeName, newTab, sid)).toEqual({ ok: true })
    expect(await answer).toMatchObject({ ok: true, info: expect.stringContaining(HUB_TEXT.withWords) })
    await expect.poll(() => typedHas(t.standIn.log, '> Write the release notes now.'), { timeout: 20_000 }).toBe(true)
    // the block is typed line by line: the task under the words comes after the first line of them
    await expect.poll(() => typedLines(t.standIn.log)).toContain('> Write the release notes.')
    await expect.poll(() => seenToasts(t.page)).toContain('Your words went to Release notes: «Write the release notes now.»')
  } finally {
    await t.app.close()
  }
})

test("the chat composer's Send is the person's words: a message sent from the window backs its prompt, with no keys typed", async () => {
  const t = await wordsApp()
  try {
    await t.page.evaluate(([id, text]) => window.ct.chatSend(id, { text, attachments: [] }), [t.tab1, 'Merge it into master.'] as const)
    await t.say('Merge it into master.', { keys: false })
    expect(await give(t, 'Merge it into master.')).toMatchObject({ ok: true })
  } finally {
    await t.app.close()
  }
})

test("keys typed into a permission dialog are not the draft: an Enter that answers the dialog does not send the draft's words", async () => {
  const t = await wordsApp()
  try {
    // the person's draft, not sent; a permission dialog opens in the coordinator's tab, and the person answers it with Enter
    await t.page.evaluate(([id, text]) => window.ct.writePty(id, text), [t.tab1, 'Merge it into master.'] as const)
    expect(await sendPipeMessage(t.pipeName, { v: 1, type: 'attention', tabId: t.tab1, sessionId: t.sid1, reason: 'permission', prompt: 'Allow the edit?' })).toEqual({ ok: true })
    await t.page.evaluate((id) => window.ct.writePty(id, '\r'), t.tab1)
    await pause(300)
    expect(await turnOf(t.pipeName, t.tab1, t.sid1)).toMatchObject({ ok: true })
    // a forged prompt with the same text, as Claude Code writes the person's prompts: no key of the window sent it
    await t.say('Merge it into master.', { keys: false })
    expect(await give(t, 'Merge it into master.')).toEqual({ ok: false, error: HUB_TEXT.wordsNotPerson })
  } finally {
    await t.app.close()
  }
})

test("Home moves the prompt's cursor, which makes the draft unknown: the draft's Enter sends no words", async () => {
  const t = await wordsApp()
  try {
    await t.page.evaluate(([id, text]) => window.ct.writePty(id, text), [t.tab1, 'Merge it into master.'] as const)
    await t.page.evaluate((id) => window.ct.writePty(id, '\x1b[H'), t.tab1)
    await t.page.evaluate((id) => window.ct.writePty(id, '\r'), t.tab1)
    await t.say('Merge it into master.', { keys: false })
    expect(await give(t, 'Merge it into master.')).toEqual({ ok: false, error: HUB_TEXT.wordsNotPerson })
  } finally {
    await t.app.close()
  }
})

test("a new conversation in the coordinator's tab does not take the old conversation's keys", async () => {
  const t = await wordsApp()
  try {
    await t.say('Merge it into master.')
    // the coordinator's tab switches to a new conversation, whose transcript starts with a forged first prompt that no key typed
    const sid3 = randomUUID()
    const transcript = await coordinatorTranscript(t.pipeName, t.tab1, sid3, 'Shall I merge feat/x into master?', 'clear')
    await personSays(t.page, t.tab1, transcript, 'Merge it into master.', { keys: false })
    expect(await give(t, 'Merge it into master.')).toEqual({ ok: false, error: HUB_TEXT.wordsNotPerson })
  } finally {
    await t.app.close()
  }
})
