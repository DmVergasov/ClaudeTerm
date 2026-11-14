import { stat } from 'node:fs/promises'
import type { PlatformPath } from 'node:path'
import type { DocCheck } from '../../shared/doc-file'
import { docKindOf, type DocKind } from '../../shared/docs'
import { splitLine, type FileLink } from '../../shared/chat-paths'
import { nativePath, pathKey } from '../path-key'

/** the file a path text of a chat names, and the line it names (null when none); null for an empty path or a network path, which is never read */
export function resolveLinkPath(folder: string, text: string, home: string, path: PlatformPath = nativePath): { file: string; line: number | null } | null {
  const ref = splitLine(text)
  if (ref.path === '' || /^[\\/]{2}/.test(ref.path)) return null
  if (ref.path === '~' || /^~[\\/]/.test(ref.path)) return { file: path.join(home, ref.path.slice(1)), line: ref.line }
  return { file: path.resolve(folder, ref.path), line: ref.line }
}

/** a regular file, links followed; false on any error, so a missing file or a folder is not a link */
export async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export interface FileLinkDeps {
  isFile(path: string): Promise<boolean>
  home: string
}

/** the files remembered per tab: past this, the oldest goes first */
export const MAX_LINKED = 10_000

/** how long one stat may take: a path on a disconnected drive or a sleeping share counts as not a file, and holds no batch */
export const STAT_TIMEOUT_MS = 2000

/** the answer of a stat, or false when it takes STAT_TIMEOUT_MS; the timer does not keep the process alive */
function withinStatTimeout(stat: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), STAT_TIMEOUT_MS)
    timer.unref()
  })
  return Promise.race([stat, limit]).finally(() => clearTimeout(timer))
}

/** The files each tab was told about by a chatFileLinks answer, so main opens only a file a chatFileLinks answer of this tab named. */
export class FileLinks {
  /** per tab, the pathKeys of its files, oldest first */
  private readonly tabs = new Map<string, Set<string>>()

  constructor(private readonly d: FileLinkDeps, private readonly path: PlatformPath = nativePath) {}

  /** One answer per distinct text that is a file, in the order given; the answered files are remembered for the tab. */
  async resolve(tabId: string, folder: string, texts: readonly string[]): Promise<FileLink[]> {
    const answers = await Promise.all([...new Set(texts)].map(async (text): Promise<FileLink | null> => {
      const r = resolveLinkPath(folder, text, this.d.home, this.path)
      if (r === null || !(await withinStatTimeout(this.d.isFile(r.file)))) return null
      return { path: text, file: r.file, kind: docKindOf(r.file) !== null ? 'doc' : 'file', line: r.line }
    }))
    const found = answers.filter((a): a is FileLink => a !== null)
    if (found.length === 0) return found
    const files = this.tabs.get(tabId) ?? new Set<string>()
    for (const f of found) {
      // a file answered again is the newest
      const key = pathKey(f.file, this.path)
      files.delete(key)
      files.add(key)
    }
    for (const key of files) {
      if (files.size <= MAX_LINKED) break
      files.delete(key)
    }
    this.tabs.set(tabId, files)
    return found
  }

  /** the file is one an answer of this tab named, compared as pathKey */
  linked(tabId: string, file: string): boolean {
    return this.tabs.get(tabId)?.has(pathKey(file, this.path)) ?? false
  }

  removeTab(tabId: string): void {
    this.tabs.delete(tabId)
  }
}

export interface OpenFileDeps {
  isFile(path: string): Promise<boolean>
  checkDoc(path: string): Promise<DocCheck>
  htmlRefused(path: string): boolean
  showDoc(tabId: string, file: string, kind: DocKind): void
  edit(file: string, line: number): void
  toast(message: string): void
}

/** Opens a linked file: a document the Docs panel can show goes there, anything else goes to the editor at its line. */
export async function openFileLink(tabId: string, file: string, line: number | null, d: OpenFileDeps): Promise<void> {
  if (!(await d.isFile(file))) {
    d.toast(`File not found: ${file}`)
    return
  }
  if (docKindOf(file) !== null) {
    const check = await d.checkDoc(file)
    // an HTML report the Docs panel refuses (its folder is the home folder or a drive root) opens in the editor
    if (check.ok && !(check.kind === 'html' && d.htmlRefused(file))) {
      d.showDoc(tabId, file, check.kind)
      return
    }
  }
  d.edit(file, line ?? 1)
}
