import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupImageCache, findTranscript, LineTailer, locateTranscript, TranscriptFeed, type FeedImage, type TranscriptFeedOptions } from '../../src/main/transcript-feed'
import type { AgentModelInfo } from '../../src/main/transcript-agent-info'
import type { PeerMail } from '../../src/main/transcript-mail'
import type { RunFile } from '../../src/main/workflow-files'
import { assistantLine, bashResultLine, editResultLine, failedResultLine, interruptLine, PEER_ORIGIN, peerMessageLine, PNG_B64, pastedLine, promptLine, sendMessageLines, textLine, toolResultLine, toolUseLine, turnPromptLine } from '../fixtures/transcript'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ct-feed-'))
  const projectDir = join(root, 'projects', 'D--x')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  const cacheRoot = join(root, 'cache')
  const images: FeedImage[] = []
  const errors: string[] = []
  const infos: [string, AgentModelInfo][] = []
  const feed = new TranscriptFeed({
    transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync,
    onImage: (i) => images.push(i), onError: (m) => errors.push(m),
    onSubagentInfo: (id, info) => infos.push([id, info])
  })
  return { root, projectDir, transcriptPath, cacheRoot, images, errors, infos, feed }
}

describe('LineTailer', () => {
  it('returns only complete lines and joins a line written in two parts', async () => {
    const { transcriptPath } = setup()
    const t = new LineTailer(transcriptPath)
    expect(await t.readNew()).toBeNull()
    writeFileSync(transcriptPath, 'first\nsec')
    expect(await t.readNew()).toEqual(['first'])
    appendFileSync(transcriptPath, 'ond\n')
    expect(await t.readNew()).toEqual(['second'])
    expect(await t.readNew()).toEqual([])
  })

  it('handles a multi-byte character split across reads', async () => {
    const { transcriptPath } = setup()
    const t = new LineTailer(transcriptPath)
    const bytes = Buffer.from('вставлено\n', 'utf8')
    writeFileSync(transcriptPath, bytes.subarray(0, 3))
    expect(await t.readNew()).toEqual([])
    appendFileSync(transcriptPath, bytes.subarray(3))
    expect(await t.readNew()).toEqual(['вставлено'])
  })
})

describe('LineTailer chunking', () => {
  it('reads across chunk boundaries, including a multi-byte char straddling one', async () => {
    const { transcriptPath } = setup()
    const lines = ['aб' + 'в'.repeat(10), 'second line', 'третья строка']
    writeFileSync(transcriptPath, lines.join('\n') + '\npartial')
    const t = new LineTailer(transcriptPath, 5)
    expect(await t.readNew()).toEqual(lines)
    appendFileSync(transcriptPath, ' end\n')
    expect(await t.readNew()).toEqual(['partial end'])
  })
})

describe('TranscriptFeed resilience', () => {
  it('survives onImage throwing: later images still delivered, onError called, interval path stays quiet', async () => {
    const { transcriptPath, cacheRoot, errors } = setup()
    const got: FeedImage[] = []
    let thrown = false
    const feed = new TranscriptFeed({
      transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, pollMs: 20,
      onImage: (i) => { if (!thrown) { thrown = true; throw new Error('boom') } got.push(i) },
      onError: (m) => errors.push(m)
    })
    writeFileSync(transcriptPath, pastedLine() + '\n' + pastedLine() + '\n')
    feed.start()
    await expect.poll(() => got.length, { timeout: 5000 }).toBe(1)
    appendFileSync(transcriptPath, pastedLine() + '\n')
    await expect.poll(() => got.length, { timeout: 5000 }).toBe(2)
    feed.stop()
    expect(errors.some((m) => m.includes('boom'))).toBe(true)
  })

  it('ignores a leftover .tmp file in the cache dir', async () => {
    const { transcriptPath, images, feed } = setup()
    writeFileSync(transcriptPath, pastedLine() + '\n')
    await feed.poll()
    const real = images[0].path
    writeFileSync(real + '.999.tmp', 'garbage')
    appendFileSync(transcriptPath, pastedLine() + '\n')
    await feed.poll()
    expect(images).toHaveLength(2)
    expect(images[1].path).toBe(real)
    expect(readFileSync(real).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
  })
})

describe('TranscriptFeed', () => {
  it('reports turn starts, edits and assistant entries, subagents included', async () => {
    const { projectDir, transcriptPath, cacheRoot } = setup()
    writeFileSync(transcriptPath, [promptLine('go', { uuid: 'p1' }), editResultLine({ toolUseId: 't1', filePath: '/p/a.ts' }), assistantLine('claude-opus-5-5')].join('\n') + '\n')
    const subagents = join(projectDir, SID, 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeFileSync(join(subagents, 'agent-a1.jsonl'), [editResultLine({ toolUseId: 't2', filePath: '/p/b.ts' }), assistantLine('claude-opus-5-5')].join('\n') + '\n')
    const events: string[] = []
    const feed = new TranscriptFeed({
      transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {},
      onEditEvent: (ev) => events.push(ev.kind === 'prompt' ? 'prompt' : `edit:${ev.toolUseId}`),
      onAssistant: (agentId) => events.push(`assistant:${agentId ?? 'main'}`)
    })
    await feed.scanSubagents()
    await feed.poll()
    expect(events).toEqual(['prompt', 'edit:t1', 'assistant:main', 'edit:t2', 'assistant:a1'])
  })

  it('reports a turn the user interrupted, in the main transcript and in a subagent\'s', async () => {
    const { projectDir, transcriptPath, cacheRoot } = setup()
    writeFileSync(transcriptPath, [promptLine('go', { uuid: 'p1' }), interruptLine({ forToolUse: true, timestamp: '2026-10-08T10:00:07.000Z' })].join('\n') + '\n')
    const subagents = join(projectDir, SID, 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeFileSync(join(subagents, 'agent-a1.jsonl'), interruptLine({ timestamp: '2026-10-08T10:00:09.000Z' }) + '\n')
    const events: [string | null, number][] = []
    const feed = new TranscriptFeed({ transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {}, onInterrupt: (agentId, at) => events.push([agentId, at]) })
    await feed.scanSubagents()
    await feed.poll()
    expect(events).toEqual([[null, Date.parse('2026-10-08T10:00:07.000Z')], ['a1', Date.parse('2026-10-08T10:00:09.000Z')]])
  })

  it('reports the turn of each main transcript prompt with whether another session started it; a subagent\'s turns and malformed positions are left out', async () => {
    const { projectDir, transcriptPath, cacheRoot } = setup()
    writeFileSync(transcriptPath, [
      turnPromptLine('go', { turnIndex: 0 }),
      turnPromptLine('build is green', { turnIndex: 1, origin: PEER_ORIGIN }),
      turnPromptLine('bad position', { turnIndex: -2, origin: PEER_ORIGIN })
    ].join('\n') + '\n')
    const subagents = join(projectDir, SID, 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeFileSync(join(subagents, 'agent-a1.jsonl'), turnPromptLine('sub', { turnIndex: 2, origin: PEER_ORIGIN }) + '\n')
    const turns: [number, boolean][] = []
    const feed = new TranscriptFeed({ transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {}, onTurn: (i, peer) => turns.push([i, peer]) })
    await feed.scanSubagents()
    await feed.poll()
    expect(turns).toEqual([[0, false], [1, true]])
  })

  it("reports the messages the main transcript sent and received with SendMessage, a call and its result read apart; a subagent's are left out", async () => {
    const { projectDir, transcriptPath, cacheRoot } = setup()
    const sentId = '3b9f6a52-7c1d-4e8a-9f20-5d6e7a8b9c0d'
    const gotId = '4c0a7b63-8d2e-4f9b-8a31-6e7f8a9b0c1e'
    const [call, result] = sendMessageLines('t1', { to: 'Review agent', message: 'Ready for review' }, { msgId: sentId, timestamp: '2026-10-08T10:00:05.000Z' })
    writeFileSync(transcriptPath, [promptLine('go'), call].join('\n') + '\n')
    const subagents = join(projectDir, SID, 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeFileSync(join(subagents, 'agent-a1.jsonl'), peerMessageLine({ ...PEER_ORIGIN, msg_id: gotId, body: 'not the session\'s' }) + '\n')
    const mail: PeerMail[] = []
    const feed = new TranscriptFeed({ transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {}, onPeerMail: (m) => mail.push(m) })
    await feed.scanSubagents()
    await feed.poll()
    expect(mail).toEqual([])
    appendFileSync(transcriptPath, [result, peerMessageLine({ ...PEER_ORIGIN, msg_id: gotId, body: 'Thanks, reviewing' }, { queued: true, timestamp: '2026-10-08T10:00:09.000Z' })].join('\n') + '\n')
    await feed.poll()
    expect(mail).toEqual([
      { kind: 'sent', id: sentId, peer: 'Review agent', text: 'Ready for review', at: Date.parse('2026-10-08T10:00:05.000Z') },
      { kind: 'received', id: gotId, peer: 'Build session', text: 'Thanks, reviewing', at: Date.parse('2026-10-08T10:00:09.000Z') }
    ])
  })

  it('a poll made while a read is in progress waits for it, then reads the lines written meanwhile', async () => {
    const { transcriptPath, cacheRoot } = setup()
    writeFileSync(transcriptPath, turnPromptLine('first', { turnIndex: 0 }) + '\n')
    const turns: number[] = []
    let late: Promise<void> | null = null
    const feed = new TranscriptFeed({
      transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {},
      onTurn: (turnIndex) => {
        turns.push(turnIndex)
        // written and asked for while the first read is still going on
        if (turnIndex === 0) {
          appendFileSync(transcriptPath, turnPromptLine('second', { turnIndex: 1 }) + '\n')
          late = feed.poll()
        }
      }
    })
    await feed.poll()
    await late
    expect(turns).toEqual([0, 1])
  })

  it('reports the workspace an sdd-workspace run printed, in the main transcript and in a subagent\'s', async () => {
    const { projectDir, transcriptPath, cacheRoot } = setup()
    const run = (id: string, ws: string): string[] => [
      toolUseLine(id, 'Bash', { command: 'bash /p/scripts/sdd-workspace docs/superpowers/plans/x.md' }),
      bashResultLine(id, ws + '\n')
    ]
    writeFileSync(transcriptPath, run('m1', '/w/a/.superpowers/sdd/2026-10-20-main').join('\n') + '\n')
    const subagents = join(projectDir, SID, 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeFileSync(join(subagents, 'agent-o1.jsonl'), run('s1', '/w/a/.superpowers/sdd/2026-10-20-sub').join('\n') + '\n')
    const printed: string[] = []
    const times: number[] = []
    const feed = new TranscriptFeed({ transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {}, onPlanWorkspace: (p, at) => (printed.push(p), times.push(at)) })
    await feed.scanSubagents()
    await feed.poll()
    expect(printed).toEqual(['/w/a/.superpowers/sdd/2026-10-20-main', '/w/a/.superpowers/sdd/2026-10-20-sub'])
    expect(times).toEqual([Date.parse('2026-10-05T10:00:01.000Z'), Date.parse('2026-10-05T10:00:01.000Z')])
  })

  it('reads history from the start and caches tool screenshots', async () => {
    const { transcriptPath, cacheRoot, images, feed } = setup()
    writeFileSync(transcriptPath, [textLine, toolUseLine('toolu_s1', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }), toolResultLine('toolu_s1', { mirror: true }), ''].join('\n'))
    await feed.poll()
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ source: 'tool', caption: 'claude-in-chrome · computer (screenshot)', at: Date.parse('2026-10-05T10:00:01.000Z') })
    expect(images[0].path.startsWith(join(cacheRoot, SID))).toBe(true)
    expect(images[0].path.endsWith('.png')).toBe(true)
    expect(readFileSync(images[0].path).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
  })

  it('Read points at the original file when it exists, otherwise at a cached copy', async () => {
    const { root, transcriptPath, cacheRoot, images, feed } = setup()
    const shot = join(root, 'shot.png')
    writeFileSync(shot, Buffer.from(PNG_B64, 'base64'))
    writeFileSync(transcriptPath, [toolUseLine('toolu_a', 'Read', { file_path: shot }), toolResultLine('toolu_a'), toolUseLine('toolu_b', 'Read', { file_path: join(root, 'gone.png') }), toolResultLine('toolu_b', { data: Buffer.from('other').toString('base64') }), ''].join('\n'))
    await feed.poll()
    expect(images.map((i) => [i.source, i.path.startsWith(cacheRoot)])).toEqual([['read', false], ['read', true]])
    expect(images[0].path).toBe(shot)
  })

  it('processes appended lines once and dedupes identical images in the cache', async () => {
    const { transcriptPath, cacheRoot, images, feed } = setup()
    writeFileSync(transcriptPath, '')
    await feed.poll()
    appendFileSync(transcriptPath, pastedLine() + '\n')
    await feed.poll()
    await feed.poll()
    appendFileSync(transcriptPath, pastedLine() + '\n')
    await feed.poll()
    expect(images).toHaveLength(2)
    expect(images[0].path).toBe(images[1].path)
    expect(images[0]).toMatchObject({ source: 'pasted', caption: 'pasted by you' })
    expect(readdirSync(join(cacheRoot, SID))).toHaveLength(1)
  })

  it('picks up subagent transcripts', async () => {
    const { transcriptPath, images, feed } = setup()
    writeFileSync(transcriptPath, '')
    mkdirSync(feed.subagentDir, { recursive: true })
    writeFileSync(join(feed.subagentDir, 'agent-a1.jsonl'), [toolUseLine('toolu_s9', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }), toolResultLine('toolu_s9'), ''].join('\n'))
    writeFileSync(join(feed.subagentDir, 'agent-a1.meta.json'), '{}')
    await feed.scanSubagents()
    await feed.poll()
    expect(images.map((i) => i.caption)).toEqual(['subagent · claude-in-chrome · computer (screenshot)'])
  })

  it('reports model and effort of a subagent once per change, ignoring synthetic lines and the main transcript', async () => {
    const { transcriptPath, infos, feed } = setup()
    writeFileSync(transcriptPath, assistantLine('claude-opus-5-5', 'xhigh') + '\n')
    mkdirSync(feed.subagentDir, { recursive: true })
    const sub = join(feed.subagentDir, 'agent-a40a10c1d655cf759.jsonl')
    writeFileSync(sub, [assistantLine('claude-sonnet-5-5', 'medium'), assistantLine('claude-sonnet-5-5', 'medium'), assistantLine('<synthetic>'), ''].join('\n'))
    await feed.scanSubagents()
    await feed.poll()
    expect(infos).toEqual([['a40a10c1d655cf759', { model: 'claude-sonnet-5-5', effort: 'medium' }]])
    appendFileSync(sub, assistantLine('claude-sonnet-5-5', 'high') + '\n')
    await feed.poll()
    expect(infos.map(([, i]) => i.effort)).toEqual(['medium', 'high'])
  })

  it('follows a transcript that Claude Code filed under another project folder', async () => {
    const { root, transcriptPath, cacheRoot, images } = setup()
    const movedDir = join(root, 'projects', 'D--moved')
    mkdirSync(movedDir)
    const moved = join(movedDir, `${SID}.jsonl`)
    writeFileSync(moved, pastedLine() + '\n')
    const feed = new TranscriptFeed({
      transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: (i) => images.push(i),
      locate: () => findTranscript(transcriptPath, SID), locateMs: 0
    })
    await feed.poll()
    expect(images.map((i) => i.source)).toEqual(['pasted'])
    appendFileSync(moved, pastedLine() + '\n')
    await feed.poll()
    expect(images).toHaveLength(2)
  })

  it('reports a missing transcript once and stops after stop()', async () => {
    const { transcriptPath, images, errors, feed } = setup()
    await feed.poll()
    await feed.poll()
    expect(errors).toHaveLength(1)
    feed.stop()
    writeFileSync(transcriptPath, pastedLine() + '\n')
    await feed.poll()
    expect(images).toEqual([])
  })
})

describe.each([
  ['locateTranscript', (p: string, s: string) => Promise.resolve(locateTranscript(p, s))],
  ['findTranscript', findTranscript]
])('%s', (_name, locate) => {
  it('is the reported path while the transcript is there', async () => {
    const { transcriptPath } = setup()
    writeFileSync(transcriptPath, '')
    expect(await locate(transcriptPath, SID)).toBe(transcriptPath)
  })

  it('finds the transcript of a session that moved to another project folder', async () => {
    const { root, transcriptPath } = setup()
    mkdirSync(join(root, 'projects', 'D--moved'))
    const moved = join(root, 'projects', 'D--moved', `${SID}.jsonl`)
    writeFileSync(moved, '')
    expect(await locate(transcriptPath, SID)).toBe(moved)
  })

  it('is null before the first message, when no project folder has it', async () => {
    const { root, transcriptPath } = setup()
    mkdirSync(join(root, 'projects', 'D--other'))
    writeFileSync(join(root, 'projects', 'D--other', '7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b.jsonl'), '')
    expect(await locate(transcriptPath, SID)).toBeNull()
  })

  it('is null when the projects folder itself is missing', async () => {
    expect(await locate(join(tmpdir(), 'ct-no-such-root', 'projects', 'D--x', `${SID}.jsonl`), SID)).toBeNull()
  })

  it('searches only Claude Code\'s projects folder, never the folder around some other path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-feed-'))
    mkdirSync(join(root, 'elsewhere', 'b'), { recursive: true })
    writeFileSync(join(root, 'elsewhere', 'b', `${SID}.jsonl`), '')
    expect(await locate(join(root, 'elsewhere', 'a', `${SID}.jsonl`), SID)).toBeNull()
  })
})

describe('TranscriptFeed session title', () => {
  const titleLine = (type: 'ai-title' | 'custom-title', text: unknown, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type, sessionId: SID, [type === 'ai-title' ? 'aiTitle' : 'customTitle']: text, ...extra })

  it('reports the current title as it changes: the last custom title, else the last AI title, not the same one twice', async () => {
    const { transcriptPath, cacheRoot } = setup()
    const titles: string[] = []
    const feed = new TranscriptFeed({
      transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {},
      onTitle: (title) => titles.push(title)
    })
    writeFileSync(transcriptPath, [
      titleLine('ai-title', 'First  title'),
      titleLine('ai-title', 'Second title'),
      titleLine('custom-title', 'Custom name'),
      titleLine('ai-title', 'Later AI title')
    ].join('\n') + '\n')
    await feed.poll()
    expect(titles).toEqual(['First title', 'Second title', 'Custom name'])
    appendFileSync(transcriptPath, titleLine('ai-title', 'Even later') + '\n')
    await feed.poll()
    expect(titles).toEqual(['First title', 'Second title', 'Custom name'])
  })

  it('ignores a sidechain title, and a malformed one', async () => {
    const { transcriptPath, cacheRoot } = setup()
    const titles: string[] = []
    const feed = new TranscriptFeed({
      transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {},
      onTitle: (title) => titles.push(title)
    })
    writeFileSync(transcriptPath, [
      titleLine('ai-title', 'Side agent title', { isSidechain: true }),
      titleLine('ai-title', 42),
      titleLine('custom-title', '   '),
      titleLine('ai-title', null),
      '{"type":"ai-title","aiTitle":"cut off'
    ].join('\n') + '\n')
    await feed.poll()
    expect(titles).toEqual([])
    appendFileSync(transcriptPath, titleLine('ai-title', 'Main title') + '\n')
    await feed.poll()
    expect(titles).toEqual(['Main title'])
  })
})

describe('TranscriptFeed EnterWorktree', () => {
  const NO_PATH = 'WorktreeCreate hook failed: hook succeeded but returned no worktree path (command: echo the path to stdout; http/callback: return hookSpecificOutput.worktreePath)'

  it("reports an EnterWorktree a WorktreeCreate hook broke, with the time of its result; a call that worked, another failure or another tool's output is none", async () => {
    const { transcriptPath, cacheRoot } = setup()
    const failures: [string, number | null][] = []
    const feed = new TranscriptFeed({
      transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {},
      onWorktreeHookFailure: (error, at) => failures.push([error, at])
    })
    writeFileSync(transcriptPath, [
      toolUseLine('ok', 'EnterWorktree', { name: 'notes' }),
      JSON.stringify({ type: 'user', timestamp: '2026-10-05T10:00:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ok', content: 'Switched to worktree D:\\x' }] }, toolUseResult: { worktreePath: 'D:\\x' } }),
      toolUseLine('git', 'EnterWorktree', { name: 'notes' }),
      failedResultLine('git', 'Not in a git repository'),
      toolUseLine('bash', 'Bash', { command: 'grep -r WorktreeCreate' }),
      failedResultLine('bash', `Exit code 1\n${NO_PATH}`)
    ].join('\n') + '\n')
    await feed.poll()
    expect(failures).toEqual([])
    appendFileSync(transcriptPath, [toolUseLine('w1', 'EnterWorktree', { name: 'notes' }), failedResultLine('w1', NO_PATH, '2026-11-17T07:30:11.976Z')].join('\n') + '\n')
    await feed.poll()
    expect(failures).toEqual([[NO_PATH, Date.parse('2026-11-17T07:30:11.976Z')]])
  })
})

describe('workflow runs', () => {
  const RUN = 'wf_55e3c3ec-b29'
  const OTHER = 'wf_66f4d4fd-c3a'
  /** the main transcript's Workflow result: the run's ids and name, as Claude Code writes it */
  const launch = (runId: string, workflowName = 'crash-triage', at = '2026-10-05T10:00:01.000Z'): string => JSON.stringify({
    type: 'user',
    timestamp: at,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wf1', content: 'Workflow launched' }] },
    toolUseResult: { status: 'async_launched', taskId: 'w9ehhq53f', taskType: 'local_workflow', workflowName, runId, transcriptDir: `/p/${SID}/subagents/workflows/${runId}` }
  })

  /** a feed on a main transcript in a temp project folder; `runDir` is a run's folder under the session's subagents folder. Everything on disk counts as live (since: 0) unless `opts` says otherwise */
  function runFeed(opts: Partial<TranscriptFeedOptions> = {}) {
    const { projectDir, transcriptPath, cacheRoot } = setup()
    const feed = new TranscriptFeed({ transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {}, pollMs: 20, since: 0, ...opts })
    const sessionDir = join(projectDir, SID)
    return { transcriptPath, sessionDir, runDir: (runId: string) => join(sessionDir, 'subagents', 'workflows', runId), feed }
  }

  it('reports the run a Workflow result launched, once, with its name and task id; a result with an invalid run id is none', async () => {
    const runs: unknown[] = []
    const { transcriptPath, feed } = runFeed({ onWorkflowRun: (run) => runs.push(run) })
    writeFileSync(transcriptPath, [promptLine('go'), launch(RUN), launch(RUN), launch('../escape')].join('\n') + '\n')
    await feed.poll()
    expect(runs).toEqual([{ runId: RUN, name: 'crash-triage', taskId: 'w9ehhq53f' }])
  })

  it('reports the journal lines of a run in order, each write as one call', async () => {
    const journals: [string, unknown[]][] = []
    const { runDir, feed } = runFeed({ onWorkflowJournal: (runId, lines) => journals.push([runId, lines]) })
    mkdirSync(runDir(RUN), { recursive: true })
    writeFileSync(join(runDir(RUN), 'journal.jsonl'), '{"type":"started","key":"0"}\n')
    await feed.scanSubagents()
    await feed.poll()
    appendFileSync(join(runDir(RUN), 'journal.jsonl'), '{"type":"result","key":"0"}\nnot json\n{"type":"started","key":"1"}\n')
    await feed.poll()
    expect(journals).toEqual([
      [RUN, [{ type: 'started', key: '0' }]],
      [RUN, [{ type: 'result', key: '0' }, { type: 'started', key: '1' }]]
    ])
  })

  it("reads a run agent's transcript as a subagent's: its model and effort, its task once, its edits and its images", async () => {
    const infos: [string, AgentModelInfo][] = []
    const tasks: [string, string, string][] = []
    const edits: string[] = []
    const captions: (string | null)[] = []
    const { runDir, feed } = runFeed({
      onSubagentInfo: (id, info) => infos.push([id, info]),
      onWorkflowTask: (runId, agentId, task) => tasks.push([runId, agentId, task]),
      onEditEvent: (ev) => edits.push(ev.kind === 'prompt' ? 'prompt' : `edit:${ev.toolUseId}`),
      onImage: (img) => captions.push(img.caption)
    })
    mkdirSync(runDir(RUN), { recursive: true })
    writeFileSync(join(runDir(RUN), 'agent-a0.jsonl'), [
      promptLine('Look at crash 1'),
      assistantLine('claude-sonnet-5-5', 'medium'),
      editResultLine({ toolUseId: 'e1', filePath: '/p/a.ts' }),
      toolUseLine('s1', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }),
      toolResultLine('s1'),
      promptLine('a second prompt')
    ].join('\n') + '\n')
    await feed.scanSubagents()
    await feed.poll()
    expect(infos).toEqual([['a0', { model: 'claude-sonnet-5-5', effort: 'medium' }]])
    expect(tasks).toEqual([[RUN, 'a0', 'Look at crash 1']])
    expect(edits).toEqual(['edit:e1'])
    expect(captions).toEqual(['subagent · claude-in-chrome · computer (screenshot)'])
  })

  it('reads two runs that both hold an agent-a0.jsonl, each with its own agent', async () => {
    const tasks: [string, string, string][] = []
    const { runDir, feed } = runFeed({ onWorkflowTask: (runId, agentId, task) => tasks.push([runId, agentId, task]) })
    for (const [runId, task] of [[RUN, 'task of run one'], [OTHER, 'task of run two']]) {
      mkdirSync(runDir(runId), { recursive: true })
      writeFileSync(join(runDir(runId), 'agent-a0.jsonl'), promptLine(task) + '\n')
    }
    await feed.scanSubagents()
    await feed.poll()
    expect(tasks).toHaveLength(2)
    expect(tasks).toEqual(expect.arrayContaining([[RUN, 'a0', 'task of run one'], [OTHER, 'a0', 'task of run two']]))
  })

  it("reports a run once, when its run file is written, with the file's state", async () => {
    const ends: [string, RunFile][] = []
    const { sessionDir, runDir, feed } = runFeed({ onWorkflowEnd: (runId, file) => ends.push([runId, file]) })
    mkdirSync(runDir(RUN), { recursive: true })
    writeFileSync(join(runDir(RUN), 'journal.jsonl'), '')
    await feed.scanSubagents()
    await feed.poll()
    expect(ends).toEqual([])
    mkdirSync(join(sessionDir, 'workflows'), { recursive: true })
    writeFileSync(join(sessionDir, 'workflows', `${RUN}.json`), JSON.stringify({ status: 'completed', workflowName: 'crash-triage', taskId: 'w9ehhq53f', durationMs: 1500 }))
    await feed.poll()
    await feed.poll()
    expect(ends.map(([runId, file]) => [runId, file.state, file.ms])).toEqual([[RUN, 'done', 1500]])
  })

  it('does not read a run folder whose name is not a run id, or one that is a link out of the subagents folder', async () => {
    const tasks: unknown[] = []
    const { sessionDir, runDir, feed } = runFeed({ onWorkflowTask: (...args) => tasks.push(args) })
    const bad = runDir('wf_BAD_NAME')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'agent-a0.jsonl'), promptLine('bad name') + '\n')
    const outside = mkdtempSync(join(tmpdir(), 'ct-run-outside-'))
    writeFileSync(join(outside, 'agent-a0.jsonl'), promptLine('linked') + '\n')
    mkdirSync(join(sessionDir, 'subagents', 'workflows'), { recursive: true })
    symlinkSync(outside, runDir(RUN), process.platform === 'win32' ? 'junction' : 'dir')
    await feed.scanSubagents()
    await feed.poll()
    expect(tasks).toEqual([])
  })

  it('reads the 8 newest run folders by modification time, and no more', async () => {
    const tasks: [string, string, string][] = []
    const { runDir, feed } = runFeed({ onWorkflowTask: (runId, agentId, task) => tasks.push([runId, agentId, task]) })
    for (let i = 0; i < 10; i++) {
      const runId = `wf_run-00${i}`
      mkdirSync(runDir(runId), { recursive: true })
      writeFileSync(join(runDir(runId), 'agent-a0.jsonl'), promptLine(`task ${i}`) + '\n')
      // set after the file is written: writing a file moves a folder's time
      const at = new Date(Date.UTC(2026, 9, 1) + i * 60_000)
      utimesSync(runDir(runId), at, at)
    }
    await feed.scanSubagents()
    await feed.poll()
    expect(tasks.map(([, , task]) => task).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `task ${i + 2}`))
  })

  it('stops reading a run that falls out of the 8 newest: its journal and its agents are not read once 8 newer runs are there', async () => {
    const journals: string[] = []
    const tasks: string[] = []
    const { runDir, feed } = runFeed({
      onWorkflowJournal: (runId) => journals.push(runId),
      onWorkflowTask: (runId, agentId, task) => tasks.push(`${runId} ${agentId} ${task}`)
    })
    const at = (i: number): Date => new Date(Date.UTC(2026, 9, 1) + i * 60_000)
    const runId = (i: number): string => `wf_run-00${i}`
    for (let i = 0; i < 8; i++) {
      mkdirSync(runDir(runId(i)), { recursive: true })
      writeFileSync(join(runDir(runId(i)), 'journal.jsonl'), '{"type":"started","key":"0"}\n')
      writeFileSync(join(runDir(runId(i)), 'agent-a0.jsonl'), promptLine(`task ${i}`) + '\n')
      utimesSync(runDir(runId(i)), at(i), at(i))
    }
    await feed.scanSubagents()
    await feed.poll()
    expect(tasks).toHaveLength(8)
    // two newer runs: the two oldest of the 8 fall out
    for (const i of [8, 9]) {
      mkdirSync(runDir(runId(i)), { recursive: true })
      writeFileSync(join(runDir(runId(i)), 'journal.jsonl'), '{"type":"started","key":"0"}\n')
      writeFileSync(join(runDir(runId(i)), 'agent-a0.jsonl'), promptLine(`task ${i}`) + '\n')
      utimesSync(runDir(runId(i)), at(i), at(i))
    }
    await feed.scanSubagents()
    await feed.poll()
    expect(tasks.slice(8).sort()).toEqual([`${runId(8)} a0 task 8`, `${runId(9)} a0 task 9`])
    // the dropped runs' files grow, and a later listing still finds them older: none of it is read
    journals.length = 0
    tasks.length = 0
    for (const i of [0, 1]) {
      appendFileSync(join(runDir(runId(i)), 'journal.jsonl'), '{"type":"result","key":"0"}\n')
      appendFileSync(join(runDir(runId(i)), 'agent-a0.jsonl'), promptLine('late') + '\n')
    }
    await feed.scanSubagents()
    await feed.poll()
    expect(journals).toEqual([])
    expect(tasks).toEqual([])
  })

  it("does not read a run's agent file that is a link out of the subagents folder; the run's other agent files are read", async ctx => {
    const tasks: [string, string, string][] = []
    const { runDir, feed } = runFeed({ onWorkflowTask: (runId, agentId, task) => tasks.push([runId, agentId, task]) })
    const outside = mkdtempSync(join(tmpdir(), 'ct-run-file-outside-'))
    const outsideFile = join(outside, 'agent-x.jsonl')
    writeFileSync(outsideFile, promptLine('from outside') + '\n')
    mkdirSync(runDir(RUN), { recursive: true })
    writeFileSync(join(runDir(RUN), 'agent-a1.jsonl'), promptLine('inside') + '\n')
    try {
      symlinkSync(outsideFile, join(runDir(RUN), 'agent-x.jsonl'), 'file')
    } catch (e) {
      // a platform that refuses a file link (Windows without developer mode) skips this case
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw e
    }
    await feed.scanSubagents()
    await feed.poll()
    expect(tasks).toEqual([[RUN, 'a1', 'inside']])
  })

  it('what is on disk when the feed starts is history: its runs, journals, tasks and run files are not reported; its agents are still read', async () => {
    const runs: unknown[] = []
    const journals: unknown[] = []
    const tasks: unknown[] = []
    const ends: unknown[] = []
    const edits: string[] = []
    const infos: [string, AgentModelInfo][] = []
    const { projectDir, transcriptPath, cacheRoot } = setup()
    const dir = join(projectDir, SID, 'subagents', 'workflows', RUN)
    writeFileSync(transcriptPath, launch(RUN) + '\n')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'journal.jsonl'), '{"type":"started","key":"0","agentId":"a0","label":"triage-a"}\n')
    writeFileSync(join(dir, 'agent-a0.jsonl'), [
      promptLine('Look at crash 1'),
      assistantLine('claude-sonnet-5-5', 'medium'),
      editResultLine({ toolUseId: 'e1', filePath: '/p/a.ts' })
    ].join('\n') + '\n')
    // writing files moved the folder's time: it was last written an hour ago, before the feed starts
    const past = new Date(Date.now() - 3_600_000)
    utimesSync(dir, past, past)
    // no `since` option: the feed's start is its history line
    const feed = new TranscriptFeed({
      transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {}, pollMs: 20,
      onWorkflowRun: (run) => runs.push(run),
      onWorkflowJournal: (runId, lines) => journals.push([runId, lines]),
      onWorkflowTask: (runId, agentId, task) => tasks.push([runId, agentId, task]),
      onWorkflowEnd: (runId) => ends.push(runId),
      onEditEvent: (ev) => edits.push(ev.kind === 'prompt' ? 'prompt' : `edit:${ev.toolUseId}`),
      onSubagentInfo: (id, info) => infos.push([id, info])
    })
    await feed.scanSubagents()
    await feed.poll()
    expect(runs).toEqual([])
    expect(journals).toEqual([])
    expect(tasks).toEqual([])
    expect(ends).toEqual([])
    expect(edits).toEqual(['edit:e1'])
    expect(infos).toEqual([['a0', { model: 'claude-sonnet-5-5', effort: 'medium' }]])
    // a run that starts after the feed is reported
    appendFileSync(transcriptPath, launch(OTHER, 'crash-triage', new Date().toISOString()) + '\n')
    const otherDir = join(projectDir, SID, 'subagents', 'workflows', OTHER)
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, 'journal.jsonl'), '{"type":"started","key":"0"}\n')
    // the folder's time as the clock reads it now: a file system's coarse clock could put a folder made just now before the feed's start
    const now = new Date()
    utimesSync(otherDir, now, now)
    await feed.scanSubagents()
    await feed.poll()
    expect(runs).toEqual([{ runId: OTHER, name: 'crash-triage', taskId: 'w9ehhq53f' }])
    expect(journals).toEqual([[OTHER, [{ type: 'started', key: '0' }]]])
  })

  it.runIf(process.platform === 'win32')('on Windows, a transcript path in 8.3 short form still reads the run folder', async () => {
    const { root, projectDir, transcriptPath, cacheRoot } = setup()
    writeFileSync(transcriptPath, '')
    // the folder's short name; a volume without short names gives the long name, and the test still runs
    // verbatim: cmd reads its quotes as they are, not as Node escapes them
    const short = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${root}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim()
    const tasks: [string, string, string][] = []
    const feed = new TranscriptFeed({
      transcriptPath: join(short, 'projects', 'D--x', `${SID}.jsonl`), sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {},
      onWorkflowTask: (runId, agentId, task) => tasks.push([runId, agentId, task])
    })
    const dir = join(projectDir, SID, 'subagents', 'workflows', RUN)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-a0.jsonl'), promptLine('short name') + '\n')
    await feed.scanSubagents()
    await feed.poll()
    expect(tasks).toEqual([[RUN, 'a0', 'short name']])
  })
})

describe('cleanupImageCache', () => {
  it('removes session folders older than the limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-cache-'))
    mkdirSync(join(root, 'old'))
    mkdirSync(join(root, 'new'))
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000)
    utimesSync(join(root, 'old'), tenDaysAgo, tenDaysAgo)
    cleanupImageCache(root, 7 * 24 * 3600 * 1000)
    expect(readdirSync(root)).toEqual(['new'])
  })
})
