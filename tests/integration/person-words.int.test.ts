import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTINUE_PROMPT } from '../../src/main/auto-continue'
import { PersonInput } from '../../src/main/coordinator/person-input'
import { checkWords, WORDS_LINE_MAX, WordsLog } from '../../src/main/coordinator/person-words'
import { TranscriptFeed } from '../../src/main/transcript-feed'
import { REPORT_WAKE_HEAD } from '../../src/shared/report-wake'
import { answerLine, bashResultLine, promptLine, queuedLine, toolUseLine } from '../fixtures/transcript'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const T = Date.parse('2026-11-16T10:00:00.000Z')
const at = (s: number): string => new Date(T + s * 1000).toISOString()

describe("the person's words, read from a coordinator's transcript on disk", () => {
  it("the feed keeps the person's prompts apart from ClaudeTerm's and the tools', and the check passes only the person's latest", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-words-'))
    const path = join(dir, `${SID}.jsonl`)
    writeFileSync(path, [
      answerLine('Shall I merge feat/x into master?', at(1)),
      promptLine('Merge it into master.', { timestamp: at(10), uuid: 'p1' }),
      toolUseLine('t1', 'Bash', { command: 'git status' }, at(11)),
      bashResultLine('t1', 'nothing to commit', at(12)),
      answerLine('I asked the parser session to merge.', at(13)),
      promptLine(`${REPORT_WAKE_HEAD} its task finished.\nfrom: parser [a10000]\nid: r1\n\n> Merged.`, { timestamp: at(20), uuid: 'p2' }),
      promptLine(CONTINUE_PROMPT, { timestamp: at(30), uuid: 'p3' }),
      ''
    ].join('\n'))
    const log = new WordsLog()
    const feed = new TranscriptFeed({ transcriptPath: path, sessionId: SID, cacheRoot: join(dir, 'cache'), fileExists: existsSync, onImage: () => {}, onWords: (l) => log.add(l, T + 120_000) })
    const input = new PersonInput()
    // the person typed "Merge it into master." in the coordinator's tab a second before Claude Code wrote it
    input.keys('tab-c', 'Merge it into master.\r', T + 9000)
    const check = (words: string) => checkWords({ words, prompts: log.prompts(), submits: input.submits('tab-c'), now: T + 120_000, startedAt: T })
    try {
      await feed.pollMain()
      expect(check('Merge it into master.')).toEqual({ ok: true, id: 'p1', words: 'Merge it into master.', context: 'Shall I merge feat/x into master?' })
      expect(check('Merged.')).toEqual({ ok: false, reason: 'not-person' })
      expect(check(CONTINUE_PROMPT)).toEqual({ ok: false, reason: 'not-person' })

      // a prompt written into the transcript with no key in the window is not the person's, and it still blocks their earlier message:
      // the latest prompt of the person's kind is the one that counts, backed or not
      appendFileSync(path, promptLine('Push it too.', { timestamp: at(40), uuid: 'p4' }) + '\n')
      await feed.pollMain()
      expect(check('Push it too.')).toEqual({ ok: false, reason: 'not-person' })
      expect(check('Merge it into master.')).toEqual({ ok: false, reason: 'not-latest' })

      // the person writes while a turn runs: Claude Code writes it as a queued message, and the earlier one can no longer be passed
      input.keys('tab-c', 'Wait, do not push.\r', T + 47_000)
      appendFileSync(path, [answerLine('Pushing now.', at(44)), queuedLine('Wait, do not push.', { timestamp: at(50), uuid: 'q1' }), ''].join('\n'))
      await feed.pollMain()
      expect(check('Merge it into master.')).toEqual({ ok: false, reason: 'not-latest' })
      expect(check('Wait, do not push.')).toEqual({ ok: true, id: 'q1', words: 'Wait, do not push.', context: 'Pushing now.' })

      // a user prompt over the longest line the feed parses, as a message with a large image is: Claude Code writes "type" first,
      // so the feed reads it from the head of the line, and it is the latest prompt, which blocks the queued one
      const big = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(WORDS_LINE_MAX) } }] },
        uuid: 'big',
        timestamp: at(60),
        isSidechain: false
      })
      appendFileSync(path, big + '\n')
      await feed.pollMain()
      expect(check('Wait, do not push.')).toEqual({ ok: false, reason: 'not-latest' })
    } finally {
      feed.stop()
    }
  })
})
