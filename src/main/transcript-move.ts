import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, cp, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { pathKey } from './path-key'

/** the largest transcript the history reads: a conversation of weeks runs to hundreds of MiB */
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024 * 1024

/** a `projects` folder of an account: `<config>/projects`; Main account and token accounts: `account` null */
export interface TranscriptRoot {
  account: string | null
  projects: string
}

/** one copy of a conversation: `<projects>/<project>/<sessionId>.jsonl`, on the account `account` */
export interface TranscriptCopy {
  account: string | null
  projects: string
  project: string
  path: string
  mtimeMs: number
}

/** what a resume does about the copies: nothing, copy one in, or refuse because the target's copy went further */
export type MoveDecision = { kind: 'none' } | { kind: 'copy'; from: TranscriptCopy } | { kind: 'refuse'; newer: TranscriptCopy }

const SESSION_ID = /^[A-Za-z0-9_-]+$/

/** two modification times this close (ms) are the same: a copy's time can differ from its source's by a fraction */
export const SAME_TIME_MS = 1

export function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) < SAME_TIME_MS
}

/** the newest copy: the largest modification time; a tie keeps the later one */
function newest(copies: TranscriptCopy[]): TranscriptCopy | null {
  let best: TranscriptCopy | null = null
  for (const c of copies) if (!best || c.mtimeMs > best.mtimeMs || sameTime(c.mtimeMs, best.mtimeMs)) best = c
  return best
}

/**
 * Whether a conversation is copied into the target's `projects` folder before it resumes there.
 * Rule A (`explicit`: Continue as, Open as) copies the source, or the newest copy without one, over an older copy
 * there; a newer copy there is refused, an equal one is the same conversation. Rule B (any other resume) runs on the
 * target's own copy and copies the newest one only when the target has none.
 */
export function decideMove(o: {
  explicit: boolean
  target: string
  source: TranscriptCopy | null
  copies: TranscriptCopy[]
}): MoveDecision {
  const target = pathKey(o.target)
  const there = (c: TranscriptCopy): boolean => pathKey(c.projects) === target

  if (!o.explicit) {
    if (o.copies.some(there)) return { kind: 'none' }
    const from = newest(o.copies)
    return from ? { kind: 'copy', from } : { kind: 'none' }
  }

  const from = o.source ?? newest(o.copies)
  if (!from || pathKey(from.projects) === target) return { kind: 'none' }
  const copy = newest(o.copies.filter(there))
  if (!copy) return { kind: 'copy', from }
  if (sameTime(copy.mtimeMs, from.mtimeMs)) return { kind: 'none' }
  return copy.mtimeMs < from.mtimeMs ? { kind: 'copy', from } : { kind: 'refuse', newer: copy }
}

/** every `<projects>/<project>/<sessionId>.jsonl` of the roots, in the roots' order; a missing root is skipped */
export async function findCopies(roots: TranscriptRoot[], sessionId: string): Promise<TranscriptCopy[]> {
  if (!SESSION_ID.test(sessionId)) return []
  const copies: TranscriptCopy[] = []
  for (const root of roots) {
    let entries: { name: string; isDirectory(): boolean }[]
    try {
      entries = await readdir(root.projects, { withFileTypes: true })
    } catch {
      continue
    }
    const found = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e): Promise<TranscriptCopy | null> => {
          const path = join(root.projects, e.name, `${sessionId}.jsonl`)
          try {
            const st = await stat(path)
            return st.isFile() ? { account: root.account, projects: root.projects, project: e.name, path, mtimeMs: st.mtimeMs } : null
          } catch {
            return null
          }
        }),
    )
    for (const c of found) if (c) copies.push(c)
  }
  return copies
}

/** the copy a reported transcript path is, compared with pathKey; null for no path or no copy */
export function copyAt(path: string | null | undefined, copies: TranscriptCopy[]): TranscriptCopy | null {
  if (!path) return null
  const key = pathKey(path)
  return copies.find((c) => pathKey(c.path) === key) ?? null
}

/**
 * A session store over one `projects` folder, for the SDK's getSessionMessages: a sign-in account's transcripts are in
 * its own folder, not in the folder the SDK reads by default. `load` returns the newest copy of the session in the
 * folder as its JSONL lines (a line that does not parse is skipped; a file over MAX_TRANSCRIPT_BYTES is not read); `append`
 * writes nothing, the history is only read. The lines are read as they stream in, so a long transcript is never one string
 * and the main process gets its turns between the chunks.
 */
export function accountSessionStore(projects: string): SessionStore {
  return {
    append: async () => undefined,
    load: async (key): Promise<SessionStoreEntry[] | null> => {
      const copies = await findCopies([{ account: null, projects }], key.sessionId)
      const copy = copies.reduce<TranscriptCopy | null>((best, c) => (!best || c.mtimeMs > best.mtimeMs ? c : best), null)
      if (!copy) return null
      try {
        if ((await stat(copy.path)).size > MAX_TRANSCRIPT_BYTES) return null
        const entries: SessionStoreEntry[] = []
        for await (const line of createInterface({ input: createReadStream(copy.path, 'utf8'), crlfDelay: Infinity })) {
          try {
            const entry: unknown = JSON.parse(line)
            if (typeof entry === 'object' && entry !== null && typeof (entry as { type?: unknown }).type === 'string') entries.push(entry as SessionStoreEntry)
          } catch {
            // a line that does not parse is skipped: transcript formats change between Claude Code versions
          }
        }
        return entries.length > 0 ? entries : null
      } catch {
        return null
      }
    },
  }
}

/** renames `from` to `to`; false when `from` does not exist */
async function moveAside(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

async function isFolder(path: string): Promise<boolean> {
  return stat(path).then(
    (st) => st.isDirectory(),
    () => false,
  )
}

/**
 * Copies a conversation and its `<id>/` folder into `<targetProjects>/<from.project>/`, keeping its modification time.
 * The folder and the transcript are written under temporary names; the transcript's rename is the commit. A failure
 * removes the temporary names and puts the target's older folder back; the error is the system's.
 */
export async function copyTranscript(from: TranscriptCopy, targetProjects: string): Promise<void> {
  const id = basename(from.path, '.jsonl')
  const srcFolder = join(dirname(from.path), id)
  const destDir = join(targetProjects, from.project)
  const destFile = join(destDir, `${id}.jsonl`)
  const destFolder = join(destDir, id)
  const suffix = randomBytes(4).toString('hex')
  const tmpFolder = join(destDir, `.${id}.ct-${suffix}`)
  const tmpFile = join(destDir, `.${id}.jsonl.ct-${suffix}`)
  const aside = join(destDir, `.${id}.ct-old-${suffix}`)
  const ignore = (): undefined => undefined

  let movedOld = false
  let placed = false
  try {
    await mkdir(destDir, { recursive: true })
    const hasFolder = await isFolder(srcFolder)
    if (hasFolder) await cp(srcFolder, tmpFolder, { recursive: true })

    const st = await stat(from.path)
    await copyFile(from.path, tmpFile)
    // seconds as numbers keep the fraction; Date would cut the time to whole milliseconds
    await utimes(tmpFile, st.atimeMs / 1000, st.mtimeMs / 1000)

    // the target's folder is replaced only by a source folder; without one it stays where it is
    if (hasFolder) {
      movedOld = await moveAside(destFolder, aside)
      await rename(tmpFolder, destFolder)
      placed = true
    }
    await rename(tmpFile, destFile)
  } catch (err) {
    if (placed) await rm(destFolder, { recursive: true, force: true }).catch(ignore)
    if (movedOld) await rename(aside, destFolder).catch(ignore)
    await rm(tmpFolder, { recursive: true, force: true }).catch(ignore)
    await rm(tmpFile, { force: true }).catch(ignore)
    throw err
  }
  if (movedOld) await rm(aside, { recursive: true, force: true }).catch(ignore)
}
