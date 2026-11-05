import { access } from 'node:fs/promises'
import { type GitRun, GitError } from './git-source'
import { nativePath, pathKey } from './path-key'
import { WORKTREE_COLORS, type TabPlace } from '../shared/types'

export interface WorktreeEntry {
  path: string
  bare: boolean
  /** the branch checked out; null when detached, or for a bare repository */
  branch: string | null
  head: string | null
}

/** `git worktree list --porcelain`: one block per worktree, blocks separated by blank lines */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), bare: false, branch: null, head: null }
      entries.push(current)
    } else if (current) {
      if (line === 'bare') current.bare = true
      else if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length)
      else if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    }
  }
  return entries
}

/** 32-bit FNV-1a of a string: the same color for the same path in every run */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * A color for each worktree, keyed by pathKey. Paths are taken in key order; each starts at its hash's color and takes the
 * first color after it no earlier path has, so a path keeps its color when others come and go.
 */
export function worktreeColors(paths: string[], size = WORKTREE_COLORS.length): Map<string, number> {
  const keys = [...new Set(paths.map((p) => pathKey(p)))].sort()
  const used = new Set<number>()
  const colors = new Map<string, number>()
  for (const key of keys) {
    const start = fnv1a(key) % size
    let color = start
    for (let i = 0; i < size; i++) {
      const c = (start + i) % size
      if (!used.has(c)) {
        color = c
        break
      }
    }
    used.add(color)
    colors.set(key, color)
  }
  return colors
}

/**
 * Where a folder is in git. Null when the folder is gone, is outside git, or git cannot run. A folder in a linked worktree
 * names that worktree and its branch; the main worktree's folder names none. Read-only git only, through `run`.
 */
export async function folderPlace(run: GitRun, folder: string): Promise<TabPlace | null> {
  // spawning in a missing folder fails like a missing git; the check is async, a folder on an offline share can take seconds
  if (!(await access(folder).then(() => true, () => false))) return null
  try {
    // line 2 names the superproject when the folder is a submodule; git's worktree list does not name the submodule's folder
    const top = await run(['rev-parse', '--show-toplevel', '--show-superproject-working-tree'], folder)
    const [topLine = '', superLine = ''] = top.stdout.toString('utf8').split(/\r?\n/)
    const topPath = topLine.trim()
    if (top.code !== 0 || !topPath) return null
    if (superLine.trim()) return submodulePlace(run, folder, topPath)
    const list = await run(['worktree', 'list', '--porcelain'], folder)
    if (list.code !== 0) return null
    const entries = parseWorktreeList(list.stdout.toString('utf8'))
    const main = entries[0]
    if (!main) return null
    const bare = main.bare
    const project = {
      key: pathKey(main.path),
      // a drive or file-system root has no folder name: the path names it
      name: (bare ? nativePath.basename(main.path).replace(/\.git$/i, '') : nativePath.basename(main.path)) || main.path,
      parent: nativePath.basename(nativePath.dirname(main.path))
    }
    const linked = bare ? entries.filter((e) => !e.bare).map((e) => e.path) : entries.slice(1).map((e) => e.path)
    const entry = entries.find((e) => pathKey(e.path) === pathKey(topPath))
    if (!entry) return null
    const colors = worktreeColors(linked)
    const worktree = bare || pathKey(topPath) !== pathKey(main.path)
      ? { path: entry.path, color: colors.get(pathKey(entry.path))! }
      : null
    return { project, worktree, branch: entry.branch ?? (entry.head ?? '').slice(0, 7) }
  } catch (e) {
    if (e instanceof GitError) return null
    throw e
  }
}

/** a submodule is a project of its own: its folder is its main worktree, named by its own folder */
async function submodulePlace(run: GitRun, folder: string, top: string): Promise<TabPlace | null> {
  const head = await run(['rev-parse', '--abbrev-ref', 'HEAD'], folder)
  let branch = head.stdout.toString('utf8').trim()
  if (head.code !== 0 || !branch) return null
  // detached: git answers HEAD
  if (branch === 'HEAD') branch = (await run(['rev-parse', '--short=7', 'HEAD'], folder)).stdout.toString('utf8').trim()
  return {
    project: { key: pathKey(top), name: nativePath.basename(top), parent: nativePath.basename(nativePath.dirname(top)) },
    worktree: null,
    branch
  }
}

export interface TabPlacesDeps {
  run: GitRun
  publish(tabId: string, place: TabPlace | null): void
}

/** a refresh of all tabs (window focus) asks git about a folder again only when its last ask is at least this old */
export const REFRESH_ALL_MIN_MS = 10_000

interface FolderEntry {
  /** when git was last asked about the folder (the start of that ask) */
  asked: number
  /** git's last answer; undefined until git has answered */
  answer: TabPlace | null | undefined
}

interface TabEntry {
  cwd: string
  key: string
  /** the last place published for the tab, as JSON; undefined before the first publish */
  last: string | undefined
}

/**
 * Keeps each tab's place up to date. Git is asked per distinct folder and its answer is kept per folder: a tab added to a
 * known folder gets that place at once, and a place is published to a tab only when it differs from the last one published
 * for it. Asks for the same folder at the same time share one git run.
 */
export class TabPlaces {
  private readonly tabs = new Map<string, TabEntry>()
  private readonly folders = new Map<string, FolderEntry>()
  private readonly asks = new Map<string, Promise<void>>()
  /** folders refreshed while git was being asked about them: their answer may be older than the refresh, so git is asked again */
  private readonly again = new Set<string>()

  constructor(private readonly deps: TabPlacesDeps) {}

  addTab(tabId: string, cwd: string): void {
    const key = pathKey(cwd)
    const tab: TabEntry = { cwd, key, last: undefined }
    this.tabs.set(tabId, tab)
    // a known folder's place is published at once; git is asked about the folder in the background all the same
    const known = this.folders.get(key)
    if (known && known.answer !== undefined) this.publish(tabId, tab, known.answer)
    this.ask(cwd)
  }

  removeTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    this.tabs.delete(tabId)
    // a folder no remaining tab uses is forgotten: its answer would be kept for nothing
    if (tab && ![...this.tabs.values()].some((t) => t.key === tab.key)) this.folders.delete(tab.key)
  }

  /**
   * activation and turn end: the tab's folder is asked about, whatever the last answer was; while an ask is in flight, once
   * more after it, since that ask may have read the folder before the change the refresh is for (a branch switched in a turn)
   */
  refresh(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    if (this.asks.has(tab.key)) this.again.add(tab.key)
    else this.ask(tab.cwd)
  }

  /** window focus: each folder of the tabs is asked about again, once, unless it was asked less than REFRESH_ALL_MIN_MS ago */
  refreshAll(): void {
    const now = Date.now()
    for (const tab of this.tabs.values()) {
      const known = this.folders.get(tab.key)
      if (!known || now - known.asked >= REFRESH_ALL_MIN_MS) this.ask(tab.cwd)
    }
  }

  private ask(folder: string): void {
    const key = pathKey(folder)
    if (this.asks.has(key)) return
    const entry = this.folders.get(key) ?? { asked: 0, answer: undefined }
    this.folders.set(key, entry)
    entry.asked = Date.now()
    // any failure answers null: a tab without a place, never an unhandled rejection in the main process
    const asked = folderPlace(this.deps.run, folder).catch(() => null).then((place) => {
      this.asks.delete(key)
      entry.answer = place
      for (const [tabId, tab] of this.tabs) if (tab.key === key) this.publish(tabId, tab, place)
      // a folder no tab uses any more is not asked about again
      if (this.again.delete(key) && this.folders.has(key)) this.ask(folder)
    })
    this.asks.set(key, asked)
  }

  private publish(tabId: string, tab: TabEntry, place: TabPlace | null): void {
    const json = JSON.stringify(place)
    if (json === tab.last) return
    tab.last = json
    this.deps.publish(tabId, place)
  }
}
