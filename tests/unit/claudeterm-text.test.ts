import { describe, expect, it } from 'vitest'
import { BACKGROUND_PROMPT, CONTINUE_PROMPT, LIMIT_PROMPT, RESUME_PROMPT } from '../../src/main/auto-continue'
import { FORWARD_HEAD } from '../../src/main/chat/agent-forward'
import { isClaudeTermText } from '../../src/main/claudeterm-text'
import { answersBody, questionsBody } from '../../src/main/coordinator/question-text'
import { roleBlock } from '../../src/main/coordinator/session-text'
import { answersText, wakeText } from '../../src/main/mail/wake-text'
import type { MailRecord } from '../../src/shared/mail'
import { MESSAGE_WAKE_HEAD, PERSON_WORDS_HEAD, REPORT_WAKE_HEAD, ROLE_NOTE_HEAD } from '../../src/shared/report-wake'

const address = (session: string, name: string) => ({ device: null, session, name })
const record = (over: Partial<MailRecord>): MailRecord => ({
  v: 1,
  id: 'm1',
  from: address('s-parser', 'parser'),
  to: address('s-app', 'app'),
  replyTo: null,
  text: 'Merge it.',
  sentAt: 1,
  delivered: false,
  read: false,
  ...over
})
const senders = () => ({ folder: null, branch: null })

describe('isClaudeTermText', () => {
  it('a head after leading spaces or after a byte order mark counts', () => {
    expect(isClaudeTermText(`   \n${MESSAGE_WAKE_HEAD} x`)).toBe(true)
    expect(isClaudeTermText(`﻿${REPORT_WAKE_HEAD} its task finished.`)).toBe(true)
    expect(isClaudeTermText(`﻿  ${PERSON_WORDS_HEAD} coord`)).toBe(true)
  })

  it('an auto-continue prompt counts, with spaces around it', () => {
    for (const prompt of [CONTINUE_PROMPT, RESUME_PROMPT, BACKGROUND_PROMPT, LIMIT_PROMPT]) {
      expect(isClaudeTermText(prompt)).toBe(true)
      expect(isClaudeTermText(`  ${prompt}\n`)).toBe(true)
    }
  })

  it("the agent forward's head counts: its text is ClaudeTerm's, not the person's", () => {
    expect(isClaudeTermText(`${FORWARD_HEAD}a10000]\nThe user wrote a message for your subagent a10000.`)).toBe(true)
    expect(isClaudeTermText(`  ${FORWARD_HEAD}a10000]`)).toBe(true)
  })

  it("the person's own words do not count", () => {
    expect(isClaudeTermText('Merge it into master.')).toBe(false)
    expect(isClaudeTermText('Note from the user, not ClaudeTerm: merge.')).toBe(false)
  })

  it('every text PromptDelivery types starts with a head: a mail block and a role note both count', () => {
    const texts = [
      wakeText([record({})], senders),
      wakeText([record({ id: 'm2', kind: 'task', project: 'acme', text: 'Fix the build.' })], senders),
      wakeText([record({ id: 'm3', kind: 'progress', replyTo: 't1', text: 'Waiting.' })], senders),
      roleBlock('You coordinate acme in ClaudeTerm: 1 session (parser, Idle).')
    ]
    for (const text of texts) expect(isClaudeTermText(text)).toBe(true)
    expect(texts[3]!.startsWith(ROLE_NOTE_HEAD)).toBe(true)
  })

  it("the typed answers, a question block and an answer block are ClaudeTerm's text", () => {
    const QS = [{ question: 'Which parts?', header: '', multiSelect: true, options: [{ label: 'Browser', description: '' }, { label: 'Cookies', description: '' }] }]
    const answers = [{ question: 'Which parts?', asked: 'parser: Which parts?', answer: 'Browser' }]
    const question = record({ id: 'm4', kind: 'question', replyTo: null, questions: QS, text: questionsBody(QS) })
    const answer = record({ id: 'm5', kind: 'answer', from: address('s-coord', 'coord'), replyTo: 'm4', answers, text: answersBody(answers) })
    for (const text of [wakeText([question], senders), wakeText([answer], senders), answersText(answer, senders)]) {
      expect(isClaudeTermText(text)).toBe(true)
      expect(isClaudeTermText(`  ${text}\n`)).toBe(true)
    }
  })
})
