import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { ASK_REASON, sessionTurnNoteText } from '../../src/main/coordinator/session-text'
import { HUB_TEXT } from '../../src/main/coordinator/coordinator-hub'
import { COORD_LANGUAGE } from '../../src/shared/coordinator'
import { ANSWER_WAKE_HEAD, ANSWERS_ABOVE, PERSON_ANSWERS_HEAD, QUESTION_WAKE_HEAD, REPORT_WAKE_HEAD } from '../../src/shared/report-wake'
import type { AskedQuestion } from '../../src/shared/questions'
import { formResultLine } from '../fixtures/transcript'
import { activate, hasMailWatcher, refOf, startSession, waitForMail } from './agent-mail'
import { chatStandIn, controlResponses, launchChatTab, sendMessage, userMessages } from './chat-helpers'
import { askedBy, chatState, coord, coordDevices, coordinatorTranscript, coordViewOf, done, makeCoordinator, stillWaiting, terminalStandInApp, turnOf, typedHas, typedLines, within } from './coordinator-helpers'
import { marksOf } from './coordinator-window'
import { closePaired, type Device, SLOW } from './device-pair'
import { gitRepo, seenToasts, watchToasts } from './helpers'

test.afterEach(closePaired)

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const TASK = 'Build the browser.'
const BROWSER = 'Where should the browser live?'
// the coordinator's own form asks the person the session's question, with the session's name in front
const PARSER = `parser: ${BROWSER}`
const SIDE = 'Side panel'

/** a question of a session or of the coordinator's form, with two options: the first is the one the window's key 1 picks */
const questionOf = (question: string): AskedQuestion => ({
  question,
  header: 'Place',
  multiSelect: false,
  options: [{ label: SIDE, description: 'Beside the terminal' }, { label: 'Own tab', description: 'A tab of its own' }]
})

/**
 * The app of the terminal view, with two Claude tabs in one repository on the stand-in, which draws Claude Code's empty prompt and logs
 * each line typed. Tab 1 is the coordinator, with a transcript; tab 2's session is attached to it, and `give` sends it the task.
 */
async function questionsApp() {
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
  return { ...l, sid1, sid2, transcript }
}

type Questions = Awaited<ReturnType<typeof questionsApp>>

/** the coordinator gives tab 2's session its task, and the stand-in shows it typed; then the session's turn starts */
async function giveTask(t: Questions): Promise<void> {
  expect(await coord(t.pipeName, t.tab1, { op: 'message', session: refOf(t.sid2), text: TASK })).toMatchObject({ ok: true })
  await expect.poll(() => typedHas(t.standIn.log, `> ${TASK}`), { timeout: 15_000 }).toBe(true)
  await turnOf(t.pipeName, t.tab2, t.sid2)
}

/** the session asks the question in its tab: the row of the session in the coordinator's view */
async function rowOf(page: Page, coordTab: string, tab: string) {
  return page.evaluate(async ([c, id]) => (await window.ct.coordView(c))?.sessions.find((r) => r.tabId === id) ?? null, [coordTab, tab] as const)
}

/**
 * The person answers the coordinator's own form in its tab: the form's dialog is reported by the hook, the window's key 1 and Enter pick
 * its first option, and the transcript gets the form's result
 */
async function answerForm(t: Questions, question: string): Promise<void> {
  expect(await askedBy(t.pipeName, t.tab1, t.sid1, [questionOf(question)])).toEqual({ ok: true })
  await t.page.evaluate((id) => window.ct.writePty(id, '1\r'), t.tab1)
  appendFileSync(t.transcript, formResultLine({ [question]: SIDE }, { timestamp: new Date().toISOString() }) + '\n')
}

/** the question block the coordinator gets for the session's question, waited for on the coordinator's mail */
const questionBlock = (t: Questions) => waitForMail(t.pipeName, t.tab1, t.sid1)

test("a session's question goes to its coordinator, not to its tab; the person's answer in the coordinator's form is typed into the session, and its report follows", async () => {
  const t = await questionsApp()
  try {
    await giveTask(t)
    const asked = questionBlock(t)
    asked.catch(() => {})
    expect(await askedBy(t.pipeName, t.tab2, t.sid2, [questionOf(BROWSER)])).toEqual({ ok: true, info: ASK_REASON })
    await expect.poll(() => rowOf(t.page, t.tab1, t.tab2)).toMatchObject({ why: 'question', line: `Asks you: ${BROWSER}` })
    expect(await t.page.evaluate((id) => window.__ct!.tabMarks!(id), t.tab2)).toMatchObject({ attention: false })

    // the session's task waits for the answer: its report does not come when the turn ends
    const report = waitForMail(t.pipeName, t.tab1, t.sid1)
    report.catch(() => {})
    const block = await within(asked, 15_000)
    expect(block.info).toContain(QUESTION_WAKE_HEAD)
    expect(block.info).toContain(`> 1. [Place] ${BROWSER}  (one answer)`)
    await done(t.pipeName, t.tab2, t.sid2)
    await stillWaiting(report, 3000)

    // the coordinator's own form: the person answers it in the coordinator's tab
    await answerForm(t, PARSER)
    const answer = await coord(t.pipeName, t.tab1, { op: 'answer', session: refOf(t.sid2), questions: [PARSER] })
    expect(answer).toMatchObject({ ok: true, info: expect.stringContaining("The person's answers went to ") })

    // the answer is typed into the idle session, under the question it answers, then the answer's block
    await expect.poll(() => typedHas(t.standIn.log, `> ${ANSWERS_ABOVE}`), { timeout: 15_000 }).toBe(true)
    const lines = typedLines(t.standIn.log)
    const order = [PERSON_ANSWERS_HEAD, `> ${BROWSER}`, `> ${PARSER}`, `> ${SIDE}`, ANSWER_WAKE_HEAD].map((text) => lines.findIndex((l) => l.includes(text)))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    await expect.poll(() => seenToasts(t.page)).toContainEqual(expect.stringMatching(/^Your answer went to .+: «Side panel»$/))

    // the session's turn on the answer ends with its report to the coordinator
    await turnOf(t.pipeName, t.tab2, t.sid2)
    await done(t.pipeName, t.tab2, t.sid2, { lastMessage: 'Built.' })
    const reported = await within(report, 15_000)
    expect(reported.info).toContain(REPORT_WAKE_HEAD)
    expect(reported.info).toContain('> Built.')
  } finally {
    await t.app.close()
  }
})

test("a line appended to the coordinator's transcript with no dialog answer behind it is refused", async () => {
  const t = await questionsApp()
  try {
    await giveTask(t)
    const asked = questionBlock(t)
    expect(await askedBy(t.pipeName, t.tab2, t.sid2, [questionOf(BROWSER)])).toEqual({ ok: true, info: ASK_REASON })
    expect(await within(asked, 15_000)).toMatchObject({ ok: true, info: expect.stringContaining(QUESTION_WAKE_HEAD) })
    await done(t.pipeName, t.tab2, t.sid2)

    // the form's result is written into the transcript, but no dialog was answered in the coordinator's tab
    appendFileSync(t.transcript, formResultLine({ [PARSER]: SIDE }, { timestamp: new Date().toISOString() }) + '\n')
    expect(await coord(t.pipeName, t.tab1, { op: 'answer', session: refOf(t.sid2), questions: [PARSER] })).toEqual({ ok: false, error: HUB_TEXT.notInForm([PARSER], []) })
    expect(HUB_TEXT.notInForm([PARSER], [])).toMatch(/Ask the person with AskUserQuestion first\.$/)

    // nothing is typed into the session
    await pause(1000)
    expect(typedHas(t.standIn.log, PERSON_ANSWERS_HEAD)).toBe(false)
  } finally {
    await t.app.close()
  }
})

test("the person writes in the session's tab first: the coordinator's answer is refused", async () => {
  const t = await questionsApp()
  try {
    await giveTask(t)
    const asked = questionBlock(t)
    expect(await askedBy(t.pipeName, t.tab2, t.sid2, [questionOf(BROWSER)])).toEqual({ ok: true, info: ASK_REASON })
    expect(await within(asked, 15_000)).toMatchObject({ ok: true, info: expect.stringContaining(QUESTION_WAKE_HEAD) })
    await done(t.pipeName, t.tab2, t.sid2)

    // the coordinator's form holds an answer, and the person's own prompt in the session's tab withdraws the question first
    await answerForm(t, PARSER)
    expect(await turnOf(t.pipeName, t.tab2, t.sid2, 'Use the side panel.')).toMatchObject({ ok: true })
    const name = (await rowOf(t.page, t.tab1, t.tab2))!.name
    expect(await coord(t.pipeName, t.tab1, { op: 'answer', session: refOf(t.sid2), questions: [PARSER] })).toEqual({ ok: false, error: HUB_TEXT.answeredInTab(name) })
    await pause(1000)
    expect(typedHas(t.standIn.log, PERSON_ANSWERS_HEAD)).toBe(false)
  } finally {
    await t.app.close()
  }
})

test("a session without a task asks in its own tab, as before", async () => {
  const t = await questionsApp()
  try {
    // attached, but no task is given: the question is not the coordinator's, so the session's tab holds it
    expect(await askedBy(t.pipeName, t.tab2, t.sid2, [questionOf(BROWSER)])).toEqual({ ok: true })
    await expect.poll(() => rowOf(t.page, t.tab1, t.tab2)).toMatchObject({ why: 'prompt' })
  } finally {
    await t.app.close()
  }
})

test("the turn notes: the coordinator's carries the person's language; the session's, on its task, names the coordinator", async () => {
  const t = await questionsApp()
  try {
    await giveTask(t)
    expect(await turnOf(t.pipeName, t.tab1, t.sid1)).toMatchObject({ ok: true, info: expect.stringContaining(COORD_LANGUAGE) })
    // the coordinator's name as the task's block names it: its from line
    const coordName = typedLines(t.standIn.log).map((l) => /^from: (.+?) \[([0-9a-f]{6})\]/.exec(l)).find((m) => m?.[2] === refOf(t.sid1))?.[1]
    expect(coordName).toBeDefined()
    expect(await turnOf(t.pipeName, t.tab2, t.sid2)).toMatchObject({ ok: true, info: sessionTurnNoteText(coordName!) })
  } finally {
    await t.app.close()
  }
})

test("chat view: the person's click on the coordinator's question card is the answer passed on", async () => {
  const work = gitRepo()
  const l = await launchChatTab({
    turns: {},
    // the coordinator's turn on the question's wake block asks the form; the block's ids are not known here
    turnsStarting: {
      [QUESTION_WAKE_HEAD]: [{
        ask: { tool: 'AskUserQuestion', input: { questions: [{ question: PARSER, header: 'Place', multiSelect: false, options: [{ label: SIDE, description: 'Beside the terminal' }, { label: 'Own tab', description: 'A tab of its own' }] }] } },
        allowed: [{ text: 'Side panel it is.' }],
        denied: []
      }]
    },
    fallback: [{ text: 'OK.' }]
  }, { work, env: { CLAUDETERM_TEST_PROMPT_DELAY_MS: '300' } })
  const { page, pipeName } = l
  const idle = (id: string) => expect.poll(async () => (await chatState(page, id))?.turn ?? null, { timeout: 30_000 }).toBe('idle')
  try {
    const a = l.tabId
    const b = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work))!.id
    await activate(page, b)
    await sendMessage(page, 'hello')
    await idle(b)
    await activate(page, a)
    await sendMessage(page, 'hello')
    await idle(a)
    const sidB = (await chatState(page, b))!.sessionId!
    expect(await makeCoordinator(page, a)).toMatchObject({ ok: true })
    expect(await coord(pipeName, a, { op: 'attach', session: refOf(sidB) })).toMatchObject({ ok: true })
    expect(await coord(pipeName, a, { op: 'message', session: refOf(sidB), text: TASK })).toMatchObject({ ok: true })
    await expect.poll(() => userMessages(l.log).some((m) => m.includes(`> ${TASK}`)), { timeout: 15_000 }).toBe(true)
    await idle(b)

    // b's question on its task goes to a: a's wake block starts a turn that asks the form
    await turnOf(pipeName, b, sidB)
    expect(await askedBy(pipeName, b, sidB, [questionOf(BROWSER)])).toEqual({ ok: true, info: ASK_REASON })
    await done(pipeName, b, sidB)
    await activate(page, a)
    const card = page.locator('.chat-host:visible .chat-card-question')
    await expect(card).toHaveCount(1, { timeout: 30_000 })
    await page.keyboard.press('1')
    await page.keyboard.press('Enter')
    await expect.poll(() => controlResponses(l.log).map((r) => (r.updatedInput as { answers?: unknown } | undefined)?.answers).filter((x) => x !== undefined)).toEqual([{ [PARSER]: SIDE }])

    // the person's click is the form's answer: passed on, it is typed into b's chat
    expect(await coord(pipeName, a, { op: 'answer', session: refOf(sidB), questions: [PARSER] })).toMatchObject({ ok: true })
    await expect.poll(() => userMessages(l.log).filter((m) => m.startsWith(PERSON_ANSWERS_HEAD)).join('\n')).toContain(`> ${SIDE}`)
  } finally {
    await l.app.close()
  }
})

/** a stand-in's settings with the terminal view: the Claude tab draws Claude Code's empty prompt, and the stand-in logs what is typed into it */
const terminalOf = (stand: ReturnType<typeof chatStandIn>): object => ({ ...stand.settings, claude: { ...(stand.settings as { claude: object }).claude, view: 'terminal' } })

/** Laptop's session attached to Studio's coordinator, as the coordinator-devices tests attach it: both windows mark it once it is confirmed */
async function attachLaptopSession(a: Device, b: Device, coordTab: string, sessionTab: string, sessionSid: string): Promise<void> {
  expect(await coord(a.pipeName, coordTab, { op: 'attach', session: refOf(sessionSid) })).toMatchObject({ ok: true })
  await expect.poll(async () => (await marksOf(b.page))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: null })
  await expect.poll(async () => (await coordViewOf(a, coordTab))?.sessions[0]?.marker, SLOW).toBeNull()
}

test("on paired devices, a question of Laptop's session goes to Studio's coordinator, and the person's answer in its form is typed into Laptop's session", async () => {
  test.setTimeout(240_000)
  const studio = chatStandIn({ turns: {} })
  const laptop = chatStandIn({ turns: {} })
  const { a, b, coordTab, coordSid, sessionTab, sessionSid } = await coordDevices({
    a: { settings: terminalOf(studio), env: { ...studio.env, CLAUDETERM_TEST_PROMPT_DELAY_MS: '300' } },
    b: { settings: terminalOf(laptop), env: { ...laptop.env, CLAUDETERM_TEST_PROMPT_DELAY_MS: '300' } }
  })
  const transcript = await coordinatorTranscript(a.pipeName, coordTab, coordSid, 'Shall I merge feat/x into master?')
  await attachLaptopSession(a, b, coordTab, sessionTab, sessionSid)
  expect(await coord(a.pipeName, coordTab, { op: 'message', session: refOf(sessionSid), text: TASK })).toMatchObject({ ok: true })
  await expect.poll(() => typedHas(laptop.log, `> ${TASK}`), SLOW).toBe(true)
  await turnOf(b.pipeName, sessionTab, sessionSid)

  // the question reaches Studio's coordinator, and the session's task waits for the answer
  const asked = waitForMail(a.pipeName, coordTab, coordSid)
  asked.catch(() => {})
  expect(await askedBy(b.pipeName, sessionTab, sessionSid, [questionOf(BROWSER)])).toEqual({ ok: true, info: ASK_REASON })
  const block = await within(asked, 30_000)
  expect(block.info).toContain(QUESTION_WAKE_HEAD)
  expect(block.info).toContain(`> 1. [Place] ${BROWSER}  (one answer)`)
  await done(b.pipeName, sessionTab, sessionSid)

  // the coordinator's own form: the person answers it in Studio's tab, and the answer goes to Laptop's session
  expect(await askedBy(a.pipeName, coordTab, coordSid, [questionOf(PARSER)])).toEqual({ ok: true })
  await a.page.evaluate((id) => window.ct.writePty(id, '1\r'), coordTab)
  appendFileSync(transcript, formResultLine({ [PARSER]: SIDE }, { timestamp: new Date().toISOString() }) + '\n')
  expect(await coord(a.pipeName, coordTab, { op: 'answer', session: refOf(sessionSid), questions: [PARSER] })).toEqual({ ok: true, info: HUB_TEXT.answered('acme · Laptop') })

  // the answer is typed into Laptop's session under the question it answers, then the answer's block
  await expect.poll(() => typedHas(laptop.log, `> ${ANSWERS_ABOVE}`), SLOW).toBe(true)
  const lines = typedLines(laptop.log)
  const order = [PERSON_ANSWERS_HEAD, `> ${BROWSER}`, `> ${PARSER}`, `> ${SIDE}`, ANSWER_WAKE_HEAD].map((text) => lines.findIndex((l) => l.includes(text)))
  expect(order.every((i) => i >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((x, y) => x - y))
})

test("on paired devices, Studio without question support: a question of Laptop's session stays in Laptop's tab, and Studio's coordinator gets none", async () => {
  test.setTimeout(240_000)
  // the same setup as the test above: only Studio's CLAUDETERM_TEST_NO_QUESTIONS differs
  const studio = chatStandIn({ turns: {} })
  const laptop = chatStandIn({ turns: {} })
  const { a, b, coordTab, coordSid, sessionTab, sessionSid } = await coordDevices({
    a: { settings: terminalOf(studio), env: { ...studio.env, CLAUDETERM_TEST_PROMPT_DELAY_MS: '300', CLAUDETERM_TEST_NO_QUESTIONS: '1' } },
    b: { settings: terminalOf(laptop), env: { ...laptop.env, CLAUDETERM_TEST_PROMPT_DELAY_MS: '300' } }
  })
  await coordinatorTranscript(a.pipeName, coordTab, coordSid, 'Shall I merge feat/x into master?')
  await attachLaptopSession(a, b, coordTab, sessionTab, sessionSid)
  expect(await coord(a.pipeName, coordTab, { op: 'message', session: refOf(sessionSid), text: TASK })).toMatchObject({ ok: true })
  await expect.poll(() => typedHas(laptop.log, `> ${TASK}`), SLOW).toBe(true)
  await turnOf(b.pipeName, sessionTab, sessionSid)

  // the task is open, so the question would be the coordinator's if Studio knew questions: here it is not. The tab is not in front on
  // Laptop, so its attention mark shows the question waits there
  await activate(b.page, b.firstTab)
  const asked = waitForMail(a.pipeName, coordTab, coordSid)
  asked.catch(() => {})
  expect(await askedBy(b.pipeName, sessionTab, sessionSid, [questionOf(BROWSER)])).toEqual({ ok: true })
  await expect.poll(async () => (await b.page.evaluate((id) => window.__ct!.tabMarks!(id), sessionTab))?.attention ?? null, SLOW).toBe(true)
  await stillWaiting(asked, 1000)
})
