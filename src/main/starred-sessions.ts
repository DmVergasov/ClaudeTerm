import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUuid } from '../shared/protocol'

/** What the device sync hears of: a star this device set. */
export interface StarSync {
  changed(id: string, starred: boolean): void
}

/** The sessions the user starred: ClaudeTerm's own file of session ids, never anything in Claude Code's folders. */
export class StarredSessions {
  readonly path: string
  /** the marker beside the file: the detached ids, kept on disk while a restore is pending */
  private readonly markerPath: string
  private readonly starred = new Set<string>()
  /** the ids set while no sync was attached: the device sync decides about them when it restores the stars */
  private readonly detached = new Set<string>()
  /** true when the file was missing, unreadable or corrupt at load, or a restore is still pending: the device sync restores the stars from the group */
  private restore = false
  /** true while the file does not hold the newest stars: a save that the marker or the disk refused */
  private dirty = false
  private sync: StarSync | null = null
  private readonly listeners = new Set<(ids: ReadonlySet<string>) => void>()

  constructor(dir: string, private readonly onError?: (message: string) => void) {
    this.path = join(dir, 'starred-sessions.json')
    this.markerPath = join(dir, 'starred-sessions.restore.json')
    this.load()
  }

  ids(): ReadonlySet<string> {
    return this.starred
  }

  /** Attaches the device sync, which hears of every star this device sets; null detaches it. */
  attach(sync: StarSync | null): void {
    this.sync = sync
  }

  /** The ids set while no sync was attached, since the last restored(). */
  detachedChanges(): ReadonlySet<string> {
    return this.detached
  }

  /** Whether the file was missing, unreadable or corrupt when it loaded: the stars then need restoring from the device sync. */
  needsRestore(): boolean {
    return this.restore
  }

  /**
   * The device sync has restored the stars: a save that did not reach the file is written now, marker first, and then the marker
   * goes and the file is the truth from now on. When a write or the marker's removal fails, the restore stays pending.
   */
  restored(): void {
    if (this.dirty) {
      if (!this.saveMarker() || !this.saveFile()) return
      this.dirty = false
    }
    try {
      rmSync(this.markerPath, { force: true })
    } catch (e) {
      this.onError?.(`cannot remove ${this.markerPath}: ${(e as Error).message}`)
      return
    }
    this.restore = false
    this.detached.clear()
  }

  set(id: string, starred: boolean): void {
    if (starred === this.starred.has(id)) return
    this.put(id, starred)
    if (!this.sync) this.detached.add(id)
    this.save()
    if (this.sync) this.sync.changed(id, starred)
  }

  /** A star another device changed: saved and given to the listeners, not sent back to the sync. Bad values are ignored. */
  applySync(id: string, starred: boolean): void {
    this.applySyncMany([[id, starred]])
  }

  /**
   * Stars another device changed, applied together: saved once, then the listeners are called once with the ids that changed.
   * Bad values are ignored, and nothing is saved or called when no star changed.
   */
  applySyncMany(entries: Array<[id: string, starred: boolean]>): void {
    const changed = new Set<string>()
    for (const [id, starred] of entries) {
      if (!isUuid(id) || typeof starred !== 'boolean') continue
      if (starred === this.starred.has(id)) continue
      this.put(id, starred)
      changed.add(id)
    }
    if (changed.size === 0) return
    this.save()
    for (const cb of [...this.listeners]) cb(changed)
  }

  /** Calls cb with the ids that another device changed; the returned function stops the calls. */
  onExternal(cb: (ids: ReadonlySet<string>) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private put(id: string, starred: boolean): void {
    if (starred) this.starred.add(id)
    else this.starred.delete(id)
  }

  private load(): void {
    this.loadMarker()
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      this.restore = true
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      return
    }
    try {
      const raw: unknown = JSON.parse(text)
      if (!Array.isArray(raw)) throw new Error('not a list')
      for (const id of raw) {
        if (isUuid(id)) this.starred.add(id)
        else this.restore = true
      }
    } catch {
      this.restore = true
      this.onError?.(`ignoring corrupt ${this.path}`)
    }
  }

  /** A marker left by a restore that did not finish: its ids are the detached changes, and the stars still need restoring. */
  private loadMarker(): void {
    let text: string
    try {
      text = readFileSync(this.markerPath, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      this.restore = true
      this.onError?.(`cannot read ${this.markerPath}: ${(e as Error).message}`)
      return
    }
    this.restore = true
    try {
      const raw: unknown = JSON.parse(text)
      if (!Array.isArray(raw)) throw new Error('not a list')
      for (const id of raw) if (isUuid(id)) this.detached.add(id)
    } catch {
      this.onError?.(`ignoring corrupt ${this.markerPath}`)
    }
  }

  /**
   * Saves the file. While a restore is pending the marker goes first, so a later run never trusts a file this run wrote
   * without it. A save that fails makes the restore pending, and the marker is tried then too.
   */
  private save(): void {
    if (this.restore && !this.saveMarker()) {
      this.dirty = true
      return
    }
    if (this.saveFile()) {
      this.dirty = false
      return
    }
    this.dirty = true
    this.restore = true
    this.saveMarker()
  }

  private saveFile(): boolean {
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify([...this.starred], null, 2), 'utf8')
      renameSync(tmp, this.path)
      return true
    } catch (e) {
      this.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
      return false
    }
  }

  private saveMarker(): boolean {
    const tmp = `${this.markerPath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify([...this.detached]), 'utf8')
      renameSync(tmp, this.markerPath)
      return true
    } catch (e) {
      this.onError?.(`cannot save ${this.markerPath}: ${(e as Error).message}`)
      return false
    }
  }
}
