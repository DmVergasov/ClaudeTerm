import { type FileHandle, open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isAgentId } from '../../shared/chat'
import { isUuid } from '../../shared/protocol'
import { isWithin } from '../path-key'

// An agent's transcript on disk: read from its end, a page of whole lines at a time, so a long agent is never read whole. Everything here
// is untrusted: a path is built only from checked ids, a link must stay inside the project folder, and a line that does not parse is skipped.

/** a line longer than this is skipped, and its bytes are not kept while the reader looks for its start */
export const LINE_CAP = 4 * 1024 * 1024
/** the file is read backward in pieces of this size */
export const CHUNK = 256 * 1024
export const PAGE_LINES = 2000
export const PAGE_BYTES = 8 * 1024 * 1024

/** a page of an agent's transcript: its lines, oldest first; `start` is where the next older page ends (0: none) */
export interface TranscriptPage { lines: Record<string, unknown>[]; start: number }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * <dirname(transcript)>/<sessionId>/subagents/agent-<agentId>.jsonl: the file Claude Code writes an agent's lines to; null when the agent
 * id fails the pattern or the session is not a uuid
 */
export function agentTranscriptPath(transcript: string, sessionId: string, agentId: string): string | null {
  if (!isAgentId(agentId) || !isUuid(sessionId)) return null
  return join(dirname(transcript), sessionId, 'subagents', `agent-${agentId}.jsonl`)
}

/**
 * The real path of an agent's file, when it lies inside the real subagents folder and that folder inside the real project folder; null
 * for anything else, or a file that is missing. A junction, a symlink or a short name is resolved first, so the check is on the real places.
 */
export async function resolveAgentTranscript(file: string): Promise<string | null> {
  try {
    const real = await realpath(file)
    const subagents = await realpath(dirname(file))
    // the project folder is the one the path names, not the one a link leads to from it
    const project = await realpath(dirname(dirname(dirname(file))))
    if (!isWithin(project, subagents) || !isWithin(subagents, real)) return null
    return real
  } catch {
    return null
  }
}

/** the bytes of a file from `position`, as many as `buf` holds: a read that stops short is an error */
async function readAt(fh: FileHandle, buf: Buffer, position: number): Promise<void> {
  let got = 0
  while (got < buf.length) {
    const r = await fh.read(buf, got, buf.length - got, position + got)
    if (r.bytesRead === 0) throw new Error('the transcript got shorter while it was read')
    got += r.bytesRead
  }
}

/**
 * The lines of a file read backward: the window holds the bytes from `from` up to the terminator of the line read next, and grows by
 * one CHUNK before `from` at a time. A line over LINE_CAP gives no bytes, and the bytes it spans are dropped while its start is sought.
 */
class BackwardLines {
  private win = Buffer.alloc(0)
  /** the file's position where the window starts */
  private from: number

  /** `end`: the position just after the next line's bytes (the line break before it is not one of them) */
  constructor(private readonly fh: FileHandle, end: number) {
    this.from = end
  }

  /**
   * The line that ends at the window's end: its start in the file, its length in bytes, and its bytes (null when it is over LINE_CAP).
   * The length counts a skipped line too, so a page can stop on the bytes it has read.
   */
  async next(): Promise<{ start: number; bytes: number; data: Buffer | null }> {
    let over = false
    const end = this.from + this.win.length
    for (;;) {
      const nl = this.win.lastIndexOf(10)
      if (nl >= 0) {
        const start = this.from + nl + 1
        const data = over || this.win.length - nl - 1 > LINE_CAP ? null : Buffer.from(this.win.subarray(nl + 1))
        // the break at nl is the next line's end, so the window ends there
        this.win = this.win.subarray(0, nl)
        return { start, bytes: end - start, data }
      }
      if (this.from === 0) {
        const data = over ? null : Buffer.from(this.win)
        this.win = Buffer.alloc(0)
        return { start: 0, bytes: end, data }
      }
      if (this.win.length > LINE_CAP) {
        over = true
        this.win = Buffer.alloc(0)
      }
      await this.grow()
    }
  }

  private async grow(): Promise<void> {
    const len = Math.min(CHUNK, this.from)
    const buf = Buffer.alloc(len)
    await readAt(this.fh, buf, this.from - len)
    this.win = Buffer.concat([buf, this.win])
    this.from -= len
  }
}

/** a line's bytes as a JSON object; null for anything else, so a line that does not parse is skipped */
function parseLine(data: Buffer): Obj | null {
  try {
    const value: unknown = JSON.parse(data.toString('utf8'))
    return isObj(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Up to PAGE_LINES whole lines, and PAGE_BYTES bytes, that end before byte `end` (null: the file's size now), oldest first. The last
 * line counts only when its line break is there: a half-written line is left for a later read.
 */
export async function readAgentPage(file: string, end: number | null): Promise<TranscriptPage> {
  const fh = await open(file, 'r')
  try {
    const size = (await fh.stat()).size
    const hi = Math.min(end ?? size, size)
    const lines: Obj[] = []
    if (hi === 0) return { lines, start: 0 }
    const last = Buffer.alloc(1)
    await readAt(fh, last, hi - 1)
    const reader = new BackwardLines(fh, last[0] === 10 ? hi - 1 : hi)
    let more = true
    // a partial last line is skipped: the reader moves past it
    if (last[0] !== 10) more = (await reader.next()).start > 0
    let start = 0
    let bytes = 0
    // the bytes read count, kept or skipped; the bytes limit applies only once the page has a line
    while (more && lines.length < PAGE_LINES && (lines.length === 0 || bytes < PAGE_BYTES)) {
      const got = await reader.next()
      start = got.start
      more = got.start > 0
      bytes += got.bytes
      if (got.data === null) continue
      const parsed = parseLine(got.data)
      if (parsed !== null) lines.push(parsed)
    }
    return { lines: lines.reverse(), start }
  } finally {
    await fh.close()
  }
}
