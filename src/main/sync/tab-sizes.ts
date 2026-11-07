// The size of a remote tab's PTY: the device used last sizes the terminal, and a change of hands resizes once.

/** by: a device id; null: this device's own window */
export interface AppliedSize {
  cols: number
  rows: number
  by: string | null
}

interface TabSize {
  applied: AppliedSize | null
  /** the window's latest fit of the tab */
  fitted: { cols: number; rows: number } | null
}

function same(a: AppliedSize | null, cols: number, rows: number, by: string | null): boolean {
  return a !== null && a.cols === cols && a.rows === rows && a.by === by
}

export class TabSizes {
  private readonly tabs = new Map<string, TabSize>()

  /** this window's fitted size: applied while the window owns the tab (or nobody does yet), kept for later otherwise */
  fit(tabId: string, cols: number, rows: number): AppliedSize | null {
    const t = this.tabs.get(tabId) ?? { applied: null, fitted: null }
    this.tabs.set(tabId, t)
    t.fitted = { cols, rows }
    if (t.applied !== null && t.applied.by !== null) return null
    if (same(t.applied, cols, rows, null)) return null
    t.applied = { cols, rows, by: null }
    return t.applied
  }

  /**
   * A device (null: this window) typed into the tab or switched to it and has it now. A device gives its size; the
   * window uses its latest fit, or the applied size while it has none.
   */
  claim(tabId: string, by: string | null, cols?: number, rows?: number): AppliedSize | null {
    const t = this.tabs.get(tabId) ?? { applied: null, fitted: null }
    let size: { cols: number; rows: number } | null
    if (by !== null) {
      size = cols !== undefined && rows !== undefined ? { cols, rows } : (t.applied ? { cols: t.applied.cols, rows: t.applied.rows } : null)
    } else {
      size = t.fitted ?? (t.applied ? { cols: t.applied.cols, rows: t.applied.rows } : null)
    }
    if (size === null) return null
    if (same(t.applied, size.cols, size.rows, by)) return null
    this.tabs.set(tabId, t)
    t.applied = { cols: size.cols, rows: size.rows, by }
    return t.applied
  }

  get(tabId: string): AppliedSize | null {
    return this.tabs.get(tabId)?.applied ?? null
  }

  /** a device's link ended: the tabs it owned go back to this window, at its latest fit */
  dropViewer(by: string): Array<[string, AppliedSize]> {
    const back: Array<[string, AppliedSize]> = []
    for (const [tabId, t] of this.tabs) {
      if (t.applied === null || t.applied.by !== by) continue
      const size = t.fitted ?? { cols: t.applied.cols, rows: t.applied.rows }
      t.applied = { cols: size.cols, rows: size.rows, by: null }
      back.push([tabId, t.applied])
    }
    return back
  }

  drop(tabId: string): void {
    this.tabs.delete(tabId)
  }
}
