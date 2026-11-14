import { appPalette, resolveTheme } from '../shared/themes'
import type { Settings } from '../shared/types'

/**
 * the theme's palette on the window's root: every part of the window, the chat too, reads its colours from it. The page
 * shows once that palette is on the root: until then it draws nothing of its own (the `themed` class marks it)
 */
export function applyTheme(theme: Settings['theme']): void {
  const palette = appPalette(resolveTheme(theme))
  for (const [name, value] of Object.entries(palette)) document.documentElement.style.setProperty(name, value)
  document.documentElement.classList.add('themed')
}
