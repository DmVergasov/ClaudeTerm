import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clampTabPanelWidth as clampWidth, TAB_PANEL_WIDTH, type TabLayout } from '../shared/types'

/** The left tab panel's width and folded groups: ClaudeTerm's own file in the data folder. */
export class TabLayoutStore {
  readonly path: string
  private layout: TabLayout = { width: TAB_PANEL_WIDTH.initial, folded: [] }

  constructor(dir: string, private readonly onError?: (message: string) => void) {
    this.path = join(dir, 'tab-layout.json')
    this.load()
  }

  get(): TabLayout {
    return { width: this.layout.width, folded: [...this.layout.folded] }
  }

  set(change: Partial<TabLayout>): void {
    if (change.width !== undefined) this.layout.width = clampWidth(change.width)
    if (change.folded !== undefined) this.layout.folded = [...change.folded]
    this.save()
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      return
    }
    try {
      const raw: unknown = JSON.parse(text)
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('not an object')
      const { width, folded } = raw as Record<string, unknown>
      if (typeof width === 'number' && Number.isFinite(width)) this.layout.width = clampWidth(width)
      if (Array.isArray(folded)) this.layout.folded = folded.filter((k): k is string => typeof k === 'string')
    } catch {
      this.onError?.(`ignoring corrupt ${this.path}`)
    }
  }

  private save(): void {
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.layout, null, 2), 'utf8')
      renameSync(tmp, this.path)
    } catch (e) {
      this.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
    }
  }
}
