import { basename, dirname, relative, sep, type PlatformPath } from 'node:path'
import { type DocInfo, type DocKind, type DocsUpdate, DOC_SCHEME } from '../shared/docs'
import type { PipeResponse } from '../shared/protocol'
import { isWithin, nativePath, pathKey } from './path-key'
import { relPathFor } from './review-sources'

/** a document a Claude tab shows: DocInfo plus the tab it is in and the folder its ctdoc:// paths are relative to */
export interface DocEntry extends DocInfo {
  tabId: string
  root: string
}

export const MAX_DOCS = 30
const NOT_CLAUDE = 'show_document works only in a ClaudeTerm Claude tab'

/** The ctdoc:// address of a document: its path relative to root, each segment encoded. */
export function docUrl(id: string, root: string, path: string): string {
  return `${DOC_SCHEME}://${id}/` + relative(root, path).split(sep).map(encodeURIComponent).join('/')
}

/**
 * An HTML report's scripts can read every file under its folder, so a document in the home folder or in a drive root is
 * not shown: that would open the user's files to its scripts. Folders are compared with pathKey.
 */
export function htmlFolderRefused(file: string, home: string, path: PlatformPath = nativePath): boolean {
  const folder = path.dirname(file)
  return pathKey(folder, path) === pathKey(home, path) || path.dirname(folder) === folder
}

export interface DocHubDeps {
  publish(update: DocsUpdate): void
  newId(): string
}

interface TabDocs {
  /** the folder the tab was opened in: Markdown files inside it are relative to it */
  folder: string
  claude: boolean
  /** newest first */
  docs: DocEntry[]
}

/** Each tab's documents from show_document, kept in memory: a Claude tab's list, newest first. */
export class DocHub {
  private readonly tabs = new Map<string, TabDocs>()

  constructor(private readonly deps: DocHubDeps) {}

  addTab(tabId: string, folder: string, claude: boolean): void {
    this.tabs.set(tabId, { folder, claude, docs: [] })
  }

  /** Forgets the tab and its documents, silently. */
  removeTab(tabId: string): void {
    this.tabs.delete(tabId)
  }

  /** show_document: the file goes to the front of the tab's list; a file the tab already has keeps its id. */
  show(tabId: string | null, path: string, title: string | null, kind: DocKind): PipeResponse {
    const tab = tabId === null ? undefined : this.tabs.get(tabId)
    if (tabId === null || !tab?.claude) return { ok: false, error: NOT_CLAUDE }
    const key = pathKey(path)
    const id = tab.docs.find((d) => pathKey(d.path) === key)?.id ?? this.deps.newId()
    const root = kind === 'markdown' && isWithin(tab.folder, path) ? tab.folder : dirname(path)
    const relPath = relPathFor(tab.folder, path)
    const entry: DocEntry = { id, tabId, path, relPath, name: basename(path), title, kind, url: docUrl(id, root, path), root }
    tab.docs = [entry, ...tab.docs.filter((d) => d.id !== id)].slice(0, MAX_DOCS)
    this.publish(tabId, tab, id)
    const note = kind === 'markdown' ? ' The user can comment on it; their comments come back to you as a message.' : ''
    return { ok: true, info: `Opened ${relPath} in the Docs panel.${note}` }
  }

  get(docId: string): DocEntry | undefined {
    for (const tab of this.tabs.values()) {
      const doc = tab.docs.find((d) => d.id === docId)
      if (doc) return doc
    }
    return undefined
  }

  /** The panel's Remove from list: the document leaves the tab's list. */
  remove(docId: string): void {
    for (const [tabId, tab] of this.tabs) {
      if (!tab.docs.some((d) => d.id === docId)) continue
      tab.docs = tab.docs.filter((d) => d.id !== docId)
      this.publish(tabId, tab, null)
      return
    }
  }

  private publish(tabId: string, tab: TabDocs, reveal: string | null): void {
    const docs: DocInfo[] = tab.docs.map((d) => ({ id: d.id, path: d.path, relPath: d.relPath, name: d.name, title: d.title, kind: d.kind, url: d.url }))
    this.deps.publish({ tabId, docs, reveal })
  }
}
