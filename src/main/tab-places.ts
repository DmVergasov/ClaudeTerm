import { existsSync } from 'node:fs'
import { type GitRun, GitError } from './git-source'
import { nativePath, pathKey } from './path-key'
import type { TabPlace } from '../shared/types'

/** the colors a linked worktree gets: the palette of the left tab panel */
export const WORKTREE_COLORS = 6

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
export function worktreeColors(paths: string[], size = WORKTREE_COLORS): Map<string, number> {
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
  // spawning in a missing folder fails like a missing git
  if (!existsSync(folder)) return null
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
      name: bare ? nativePath.basename(main.path).replace(/\.git$/i, '') : nativePath.basename(main.path),
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

/**
 * Keeps each tab's place up to date: asks git when a tab is added or refreshed and publishes the answer when it differs from
 * the last one published for that tab. Asks for the same folder at the same time share one git run.
 */
export class TabPlaces {
  private readonly tabs = new Map<string, { cwd: string; last: string | undefined }>()
  private readonly asks = new Map<string, Promise<TabPlace | null>>()

  constructor(private readonly deps: TabPlacesDeps) {}

  addTab(tabId: string, cwd: string): void {
    this.tabs.set(tabId, { cwd, last: undefined })
    this.refresh(tabId)
  }

  removeTab(tabId: string): void {
    this.tabs.delete(tabId)
  }

  refresh(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.ask(tab.cwd).then((place) => {
      // the tab closed while git was asked
      const current = this.tabs.get(tabId)
      if (!current) return
      const json = JSON.stringify(place)
      if (json === current.last) return
      current.last = json
      this.deps.publish(tabId, place)
    })
  }

  refreshAll(): void {
    for (const tabId of [...this.tabs.keys()]) this.refresh(tabId)
  }

  private ask(folder: string): Promise<TabPlace | null> {
    const key = pathKey(folder)
    const pending = this.asks.get(key)
    if (pending) return pending
    // any failure answers null: a tab without a place, never an unhandled rejection in the main process
    const asked = folderPlace(this.deps.run, folder).catch(() => null).finally(() => { this.asks.delete(key) })
    this.asks.set(key, asked)
    return asked
  }
}
