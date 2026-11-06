import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isUuid } from '../shared/protocol'
import { normalizeTaskList, type TaskList } from '../shared/task-list'

/** The most task lists kept on disk; the ones changed longest ago go first. */
export const MAX_STORED_LISTS = 200

export interface StoredTaskList {
  list: TaskList
  /** when Claude last changed the list, in ms since the epoch */
  changedAt: number
}

/** Reads the task lists file: valid entries by session id; null when the text is not a JSON object. */
export function parseTaskLists(text: string): Map<string, StoredTaskList> | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const lists = new Map<string, StoredTaskList>()
  for (const [id, value] of Object.entries(raw)) {
    if (!isUuid(id) || typeof value !== 'object' || value === null) continue
    const v = value as Record<string, unknown>
    if (typeof v.changedAt !== 'number' || !Number.isFinite(v.changedAt)) continue
    const checked = normalizeTaskList(v.list)
    if (!checked.ok || !checked.list) continue
    lists.set(id, { list: checked.list, changedAt: v.changedAt })
  }
  return lists
}

export interface TaskListStoreOptions {
  debounceMs?: number
  onError?(message: string): void
  /** what the user is told: the file could not be read */
  warn?(message: string): void
  now?(): number
}

const copyList = (list: TaskList): TaskList => ({ title: list.title, tasks: list.tasks.map((task) => ({ ...task })) })

/** The task list Claude keeps for each Claude session: ClaudeTerm's own file, never anything in Claude Code's folders. */
export class TaskListStore {
  readonly path: string
  private readonly lists = new Map<string, StoredTaskList>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  /** false when a file that could not be read could not be moved aside either: it is never written over */
  private writable = true

  constructor(dir: string, private readonly opts: TaskListStoreOptions = {}) {
    this.path = join(dir, 'task-lists.json')
    this.load()
  }

  get(sessionId: string): TaskList | null {
    const stored = this.lists.get(sessionId)
    return stored ? copyList(stored.list) : null
  }

  /** Stores the list; null removes it. */
  set(sessionId: string, list: TaskList | null): void {
    if (list) {
      const changedAt = this.opts.now ? this.opts.now() : Date.now()
      this.lists.set(sessionId, { list: copyList(list), changedAt })
    } else {
      this.lists.delete(sessionId)
    }
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? 500)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty || !this.writable) return
    this.dirty = false
    this.keepNewest()
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.lists), null, 2), 'utf8')
      renameSync(tmp, this.path)
    } catch (e) {
      this.opts.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
    }
  }

  private keepNewest(): void {
    if (this.lists.size <= MAX_STORED_LISTS) return
    const newest = [...this.lists].sort((a, b) => b[1].changedAt - a[1].changedAt).slice(0, MAX_STORED_LISTS)
    this.lists.clear()
    for (const [id, stored] of newest) this.lists.set(id, stored)
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      this.opts.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      this.moveAside()
      return
    }
    const parsed = parseTaskLists(text)
    if (!parsed) {
      this.moveAside()
      return
    }
    for (const [id, stored] of parsed) this.lists.set(id, stored)
  }

  /** a file that is not task lists is kept beside the new one, never written over; the lists start empty */
  private moveAside(): void {
    const aside = `${this.path}.corrupt-${Date.now()}`
    try {
      renameSync(this.path, aside)
      this.opts.warn?.(`Task lists could not be read; the file was kept as ${basename(aside)}`)
    } catch (e) {
      this.writable = false
      this.opts.onError?.(`cannot move ${this.path} aside: ${(e as Error).message}`)
      this.opts.warn?.(`Task lists could not be read and are not being saved this run: ${this.path}`)
    }
  }
}
