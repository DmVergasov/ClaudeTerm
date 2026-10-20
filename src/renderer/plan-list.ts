import type { PlanStatus, PlanTaskState } from '../shared/types'

export const PLAN_MARKS: Record<PlanTaskState, string> = { done: '✓', current: '●', left: '○' }

export function planCountText(p: PlanStatus): string {
  return `${p.done} of ${p.total} done`
}

/** The box above the status bar that lists every task of a plan run as done, current or still to come. */
export class PlanList {
  constructor(private readonly el: HTMLElement, private readonly onClosed: () => void) {}

  get isOpen(): boolean {
    return !this.el.hidden
  }

  toggle(anchor: HTMLElement, plan: PlanStatus): void {
    if (this.isOpen) {
      this.close()
      return
    }
    this.render(plan)
    this.el.hidden = false
    this.place(anchor)
    // capture phase: Esc must not reach the terminal, where it would interrupt Claude's turn
    document.addEventListener('keydown', this.onKey, true)
    document.addEventListener('mousedown', this.onMouseDown, true)
  }

  update(plan: PlanStatus | null): void {
    if (!this.isOpen) return
    if (!plan) {
      this.close()
      return
    }
    this.render(plan)
    this.place()
  }

  close(): void {
    if (!this.isOpen) return
    this.el.hidden = true
    this.el.replaceChildren()
    document.removeEventListener('keydown', this.onKey, true)
    document.removeEventListener('mousedown', this.onMouseDown, true)
    this.onClosed()
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    this.close()
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    const t = e.target as Element | null
    // a press on the segment is left to its click, which toggles
    if (this.el.contains(t) || t?.closest?.('.status-plan')) return
    this.close()
  }

  private render(plan: PlanStatus): void {
    const head = document.createElement('div')
    head.className = 'plan-head'
    const title = document.createElement('span')
    title.className = 'plan-title'
    title.textContent = plan.title
    const count = document.createElement('span')
    count.className = 'plan-count'
    count.textContent = planCountText(plan)
    head.append(title, count)
    const rows = plan.tasks.map((t) => {
      const row = document.createElement('div')
      row.className = `plan-task ${t.state}`
      const mark = document.createElement('span')
      mark.className = 'plan-mark'
      mark.textContent = PLAN_MARKS[t.state]
      const name = document.createElement('span')
      name.className = 'plan-task-title'
      name.textContent = t.title || `Task ${t.n}`
      row.append(mark, name)
      return row
    })
    this.el.replaceChildren(head, ...rows)
  }

  /** bottom edge 4px above the status bar, left edge at the segment, kept inside the window */
  private place(opened?: HTMLElement): void {
    // the status bar replaces its segments when the set of them changes, so the one the list opened from may be gone
    const seg = opened ?? document.querySelector<HTMLElement>('#statusbar .status-plan')
    if (!seg) {
      this.close()
      return
    }
    const a = seg.getBoundingClientRect()
    const r = this.el.getBoundingClientRect()
    const bar = seg.closest('#statusbar')?.getBoundingClientRect() ?? a
    this.el.style.left = `${Math.max(0, Math.min(a.left, window.innerWidth - r.width - 4))}px`
    this.el.style.bottom = `${Math.max(0, window.innerHeight - bar.top + 4)}px`
  }
}
