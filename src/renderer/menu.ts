export interface MenuItem {
  label: string
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

export function showMenu(at: { x: number; y: number }, items: MenuItem[]): void {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'menu'
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
  menu.style.top = `${Math.max(0, Math.min(at.y, window.innerHeight - r.height - 4))}px`
  current = menu
  setTimeout(() => document.addEventListener('mousedown', onOutside, { once: true }), 0)
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu()
})
