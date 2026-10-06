import { createHash } from 'node:crypto'
import type { PlatformPath } from 'node:path'
import type { ImageCard, ImageSource } from '../shared/types'
import { nativePath, pathKey } from './path-key'

export interface ImageHubOptions {
  maxItems(): number
  onChange(tabId: string): void
  now?(): number
  /** the flavour of the image paths; the platform's own unless a test says otherwise */
  path?: PlatformPath
}

interface Feed {
  cwd: string
  /** the session's temp folder, where its scratchpad is */
  tempDir: string | null
  cards: ImageCard[]
  unseen: Set<string>
  notice: string | null
}

const SOURCE_RANK: Record<ImageSource, number> = { created: 0, read: 1, tool: 1, pasted: 1, shown: 2 }

export function cardId(tabId: string, file: string, path: PlatformPath = nativePath): string {
  return createHash('sha1').update(`${tabId}\0${pathKey(file, path)}`).digest('hex').slice(0, 20)
}

/** `file` inside the tab's folder or the session's temp folder, else in full */
export function relPathOf(cwd: string, file: string, tempDir: string | null = null, path: PlatformPath = nativePath): string {
  for (const root of tempDir ? [cwd, tempDir] : [cwd]) {
    const r = path.relative(root, file)
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r
  }
  return file
}

export class ImageHub {
  private readonly feeds = new Map<string, Feed>()

  constructor(private readonly o: ImageHubOptions) {}

  private get paths(): PlatformPath {
    return this.o.path ?? nativePath
  }

  addTab(tabId: string, cwd: string): void {
    if (!this.feeds.has(tabId)) this.feeds.set(tabId, { cwd, tempDir: null, cards: [], unseen: new Set(), notice: null })
  }

  setTempDir(tabId: string, dir: string | null): void {
    const f = this.feeds.get(tabId)
    if (f) f.tempDir = dir
  }

  removeTab(tabId: string): void {
    this.feeds.delete(tabId)
  }

  hasTab(tabId: string): boolean {
    return this.feeds.has(tabId)
  }

  setNotice(tabId: string, notice: string | null): void {
    const f = this.feeds.get(tabId)
    if (!f || f.notice === notice) return
    f.notice = notice
    this.o.onChange(tabId)
  }

  /** `contentChanged` is true only for a real file modification (watcher `change`): it bumps the version and marks the card updated. */
  add(tabId: string, path: string, source: ImageSource, caption: string | null, at?: number, contentChanged = false): ImageCard | null {
    const f = this.feeds.get(tabId)
    if (!f) return null
    const id = cardId(tabId, path, this.paths)
    const touchedAt = at ?? this.o.now?.() ?? Date.now()
    const idx = f.cards.findIndex((c) => c.id === id)
    let card: ImageCard
    if (idx >= 0) {
      const prev = f.cards[idx]
      f.cards.splice(idx, 1)
      card = {
        ...prev,
        version: contentChanged ? prev.version + 1 : prev.version,
        updated: contentChanged || prev.updated,
        deleted: false,
        touchedAt,
        caption: caption ?? prev.caption,
        source: SOURCE_RANK[source] >= SOURCE_RANK[prev.source] ? source : prev.source
      }
    } else {
      card = { id, tabId, path, name: this.paths.basename(path), relPath: relPathOf(f.cwd, path, f.tempDir, this.paths), source, caption, touchedAt, version: 1, updated: false, deleted: false }
    }
    f.cards.unshift(card)
    // a known file reported again by another source (e.g. the folder watcher after show_image) is not news
    if (idx < 0 || contentChanged) f.unseen.add(id)
    const max = Math.max(1, this.o.maxItems())
    while (f.cards.length > max) {
      const dropped = f.cards.pop()
      if (dropped) f.unseen.delete(dropped.id)
    }
    this.o.onChange(tabId)
    return { ...card }
  }

  markDeleted(tabId: string, path: string): void {
    const f = this.feeds.get(tabId)
    const c = f?.cards.find((x) => x.id === cardId(tabId, path, this.paths))
    if (!c || c.deleted) return
    c.deleted = true
    this.o.onChange(tabId)
  }

  remove(id: string): ImageCard | null {
    for (const [tabId, f] of this.feeds) {
      const i = f.cards.findIndex((c) => c.id === id)
      if (i < 0) continue
      const [c] = f.cards.splice(i, 1)
      f.unseen.delete(id)
      this.o.onChange(tabId)
      return c
    }
    return null
  }

  get(id: string): ImageCard | null {
    for (const f of this.feeds.values()) {
      const c = f.cards.find((x) => x.id === id)
      if (c) return { ...c }
    }
    return null
  }

  list(tabId: string): ImageCard[] {
    return this.feeds.get(tabId)?.cards.map((c) => ({ ...c })) ?? []
  }

  unseenCount(tabId: string): number {
    return this.feeds.get(tabId)?.unseen.size ?? 0
  }

  notice(tabId: string): string | null {
    return this.feeds.get(tabId)?.notice ?? null
  }

  markSeen(tabId: string): void {
    const f = this.feeds.get(tabId)
    if (!f || f.unseen.size === 0) return
    f.unseen.clear()
    this.o.onChange(tabId)
  }

  resolveTarget(tabId: string | null, activeTabId: string | null): string | null {
    if (tabId && this.feeds.has(tabId)) return tabId
    if (activeTabId && this.feeds.has(activeTabId)) return activeTabId
    return null
  }
}
