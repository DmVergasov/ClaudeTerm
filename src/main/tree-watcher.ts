import { EventEmitter } from 'node:events'
import { lstatSync, readdirSync, statSync, watch, type Dirent, type FSWatcher, type Stats } from 'node:fs'
import { basename, join, sep } from 'node:path'

export interface TreeWatchConfig {
  /** folder names not looked into, compared without case */
  ignore: string[]
  /** how many folders deep files are reported */
  maxDepth: number
}

const isMissing = (err: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')

/** stat or lstat that answers undefined instead of throwing: a path changes under a watcher all the time */
function statOf(p: string, link = false): Stats | undefined {
  try {
    return link ? lstatSync(p) : statSync(p)
  } catch {
    return undefined
  }
}

/**
 * A recursive folder watch made of one watch per folder, for Linux. Node's own stand-in there follows folders by path:
 * a folder deleted and created again before it notices is never watched again, and it holds a watch on every file.
 * Names are relative to `root`, as from a recursive fs.watch, and the files a folder holds when it turns up are
 * reported too; '' is `root` itself gone.
 *
 * A folder's watch lives until the folder's own deletion (or move) event, the last one Linux sends for it: the events
 * queued before it, such as the deletion of every file of a folder removed with `rm -rf`, all get reported. A new
 * folder at the same path gets a watch of its own as soon as it is noticed.
 */
export class TreeWatcher extends EventEmitter {
  /** the watch of each folder path now */
  private readonly dirs = new Map<string, { w: FSWatcher; ino: number }>()
  /** every open watch, also those of folders already replaced that still report their last events */
  private readonly open = new Set<FSWatcher>()
  private readonly ignore: Set<string>
  private closed = false

  constructor(
    private readonly root: string,
    private readonly onEvent: (event: string, name: string | null) => void,
    private readonly cfg: TreeWatchConfig
  ) {
    super()
    this.ignore = new Set(cfg.ignore.map((s) => s.toLowerCase()))
    this.addDir('', false)
  }

  close(): void {
    this.closed = true
    for (const w of this.open) w.close()
    this.open.clear()
    this.dirs.clear()
  }

  private abs(rel: string): string {
    return rel ? join(this.root, rel) : this.root
  }

  private watchable(rel: string): boolean {
    return rel.split(sep).length <= this.cfg.maxDepth && !this.ignore.has(basename(rel).toLowerCase())
  }

  private stop(w: FSWatcher): void {
    w.close()
    this.open.delete(w)
  }

  /** Watches folder `rel` and the folders in it, unless this very folder is watched already; `announce` reports what it holds. */
  private addDir(rel: string, announce: boolean): void {
    if (this.closed) return
    const abs = this.abs(rel)
    let w: FSWatcher
    let ino: number
    try {
      const st = statSync(abs)
      if (rel && !st.isDirectory()) return
      if (this.dirs.get(rel)?.ino === st.ino) return
      ino = st.ino
      w = watch(abs, (event, name) => this.onDirEvent(rel, w, event, name))
    } catch (err) {
      // the root must be there; a folder inside may be gone again already
      if (!rel) throw err
      if (!isMissing(err)) process.nextTick(() => this.emit('error', err))
      return
    }
    w.on('error', (err) => {
      this.stop(w)
      if (!rel && this.dirs.get('')?.w === w) this.emit('error', err)
    })
    this.open.add(w)
    // a watch this replaces is left to report its last events and close on its own
    this.dirs.set(rel, { w, ino })
    let entries: Dirent[]
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = rel ? join(rel, e.name) : e.name
      if (announce) this.onEvent('rename', child)
      if (e.isDirectory() && this.watchable(child)) this.addDir(child, announce)
    }
  }

  private onDirEvent(rel: string, w: FSWatcher, event: string, name: string | null): void {
    if (this.closed) return
    if (name === null) {
      this.onEvent(event, null)
      return
    }
    // A file of a folder deleted or replaced is reported too: whoever listens finds out what is there now. Linux names
    // the folder itself (deleted, moved, its attributes changed) by its own name, always as a 'rename' (a folder's
    // events carry IN_ISDIR); a file named like its folder only costs watching the folder again.
    const child = rel ? join(rel, name) : name
    this.onEvent(event, child)
    const itself = name === basename(this.abs(rel))
    if (this.dirs.get(rel)?.w !== w) {
      // a replaced folder's watch: its folder is gone once it says so
      if (itself) this.stop(w)
      return
    }
    const now = statOf(this.abs(rel))
    if (itself) {
      // this folder is gone; a new one may have its place, even its inode number
      this.stop(w)
      this.dirs.delete(rel)
      if (!now) {
        if (!rel) this.onEvent('rename', '')
      } else if (!rel || this.watchable(rel)) this.addDir(rel, true)
      return
    }
    // a new folder at this path already: watch it, and let this watch finish reporting the old one
    if (now && now.ino !== this.dirs.get(rel)?.ino && now.isDirectory()) this.addDir(rel, true)
    if (statOf(this.abs(child), true)?.isDirectory() && this.watchable(child)) this.addDir(child, true)
  }
}
