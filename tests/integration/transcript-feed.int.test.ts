import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupImageCache, findTranscript, LineTailer, locateTranscript, TranscriptFeed, type FeedImage } from '../../src/main/transcript-feed'
import type { AgentModelInfo } from '../../src/main/transcript-agent-info'
import { assistantLine, PNG_B64, pastedLine, textLine, toolResultLine, toolUseLine } from '../fixtures/transcript'

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
    feed.scanSubagents()
    await feed.poll()
    expect(images.map((i) => i.caption)).toEqual(['subagent · claude-in-chrome · computer (screenshot)'])
  })

  it('reports model and effort of a subagent once per change, ignoring synthetic lines and the main transcript', async () => {
    const { transcriptPath, infos, feed } = setup()
    writeFileSync(transcriptPath, assistantLine('claude-opus-5-5', 'xhigh') + '\n')
    mkdirSync(feed.subagentDir, { recursive: true })
    const sub = join(feed.subagentDir, 'agent-a40a10c1d655cf759.jsonl')
    writeFileSync(sub, [assistantLine('claude-sonnet-5-5', 'medium'), assistantLine('claude-sonnet-5-5', 'medium'), assistantLine('<synthetic>'), ''].join('\n'))
    feed.scanSubagents()
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
