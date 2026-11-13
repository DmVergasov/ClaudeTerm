import { existsSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { pathKey } from '../path-key'

// Watches the folders of Claude Code's configuration files and calls back, debounced, when a watched file may have changed.
// One non-recursive watch per folder. The turn-end comparison covers whatever a watch misses, so every error here is quiet.

const DEFAULT_DEBOUNCE_MS = 300

interface FolderWatch {
  watcher: FSWatcher
  names: Set<string> // pathKeys of the file names watched in this folder
}

export class ConfigWatch {
  private folders = new Map<string, FolderWatch>() // by pathKey of the folder
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly debounceMs: number

  constructor(private readonly onChange: () => void, o: { debounceMs?: number } = {}) {
    this.debounceMs = o.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  /** the files to watch now: folders no longer named are unwatched, a folder that does not exist yet is tried again on the next call */
  setFiles(files: string[]): void {
    if (this.closed) return
    const wanted = new Map<string, { dir: string; names: Set<string> }>()
    for (const file of files) {
      const dir = dirname(file)
      const key = pathKey(dir)
      let entry = wanted.get(key)
      if (!entry) {
        entry = { dir, names: new Set() }
        wanted.set(key, entry)
      }
      entry.names.add(pathKey(basename(file)))
    }
    for (const [key, folder] of this.folders) {
      if (!wanted.has(key)) this.unwatch(key, folder)
    }
    for (const [key, entry] of wanted) {
      const folder = this.folders.get(key)
      if (folder) {
        folder.names = entry.names
      } else {
        this.watchFolder(key, entry.dir, entry.names)
      }
    }
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const [key, folder] of this.folders) this.unwatch(key, folder)
  }

  private watchFolder(key: string, dir: string, names: Set<string>): void {
    if (!existsSync(dir)) return
    let watcher: FSWatcher
    try {
      watcher = watch(dir, (_event, filename) => {
        // an event with no name (or one that is not a file name) may concern a watched file: it counts
        if (!filename || names.has(pathKey(String(filename)))) this.arm()
      })
    } catch {
      return
    }
    // a watch error (the folder went away, the platform gave up) closes this watch quietly; the next setFiles tries again
    watcher.on('error', () => {
      const folder = this.folders.get(key)
      if (folder && folder.watcher === watcher) this.unwatch(key, folder)
    })
    this.folders.set(key, { watcher, names })
  }

  private unwatch(key: string, folder: FolderWatch): void {
    this.folders.delete(key)
    try {
      folder.watcher.close()
    } catch {
      // already closed
    }
  }

  private arm(): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.closed) this.onChange()
    }, this.debounceMs)
  }
}
