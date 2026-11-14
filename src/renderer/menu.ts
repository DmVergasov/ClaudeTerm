export interface MenuItem {
  label: string
  /** a shortcut written at the right of the row */
  hint?: string
  action?: () => void
  disabled?: boolean
  separator?: boolean
}

let current: HTMLElement | null = null

export function closeMenu(): void {
  current?.remove()
  current = null
}

function onOutside(e: MouseEvent): void {
  if (!current) return
  if (current.contains(e.target as Node)) {
    document.addEventListener('mousedown', onOutside, { once: true })
    return
  }
  closeMenu()
}

/** whether this menu is the one on screen: a menu that closed, or was replaced, is not */
export function menuIsOpen(menu: HTMLElement): boolean {
  return current === menu
}

/** shows the menu at a place, replacing the one on screen; returns it. `animate: false` draws it in place without the pop-in */
export function showMenu(at: { x: number; y: number }, items: MenuItem[], o: { animate?: boolean } = {}): HTMLElement {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = o.animate === false ? 'menu menu-still' : 'menu'
  for (const it of items) {
    if (it.separator) {
      const sep = document.createElement('div')
      sep.className = 'menu-sep'
      menu.append(sep)
      continue
    }
    const row = document.createElement('div')
    row.className = `menu-item${it.disabled ? ' disabled' : ''}`
    row.textContent = it.label
    if (it.hint) {
      const hint = document.createElement('span')
      hint.className = 'menu-hint'
      hint.textContent = it.hint
      row.append(hint)
    }
    if (!it.disabled && it.action) {
      const action = it.action
      row.addEventListener('click', () => {
        closeMenu()
        action()
      })
    }
    menu.append(row)
  }
  document.body.append(menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(0, Math.min(at.x, window.innerWidth - r.width - 4))}px`
  // a menu stays below the title bar, the window's drag strip, even when it is taller than the room under its anchor
  const barBottom = document.getElementById('titlebar')?.getBoundingClientRect().bottom ?? 0
  menu.style.top = `${Math.max(barBottom, Math.min(at.y, window.innerHeight - r.height - 4))}px`
  current = menu
  setTimeout(() => document.addEventListener('mousedown', onOutside, { once: true }), 0)
  return menu
}

// the unit tests import the menu's users without a window: no listener then
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu()
  })
}
