import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { macMenuTemplate } from '../../src/main/mac-menu'

const items = (t: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  t.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? items(i.submenu) : [])])

describe('macMenuTemplate', () => {
  it('has the app menu every Mac app has: About, Settings…, Hide, Quit', () => {
    const [appMenu] = macMenuTemplate('ClaudeTerm', () => {})
    expect(appMenu.label).toBe('ClaudeTerm')
    const roles = items([appMenu]).map((i) => i.role).filter(Boolean)
    expect(roles).toEqual(expect.arrayContaining(['about', 'hide', 'hideOthers', 'unhide', 'quit']))
  })

  it('Settings… (⌘,) opens the settings window', () => {
    let opened = 0
    const settings = items(macMenuTemplate('ClaudeTerm', () => { opened++ })).find((i) => i.label === 'Settings…')!
    expect(settings.accelerator).toBe('Command+,')
    ;(settings.click as () => void)()
    expect(opened).toBe(1)
  })

  it('has Edit, whose items give text fields ⌘C, ⌘V and ⌘A, and Window', () => {
    expect(macMenuTemplate('ClaudeTerm', () => {}).map((i) => i.role)).toEqual([undefined, 'editMenu', 'windowMenu'])
  })

  it('has no Close: ⌘W from a text field would close the window instead of the tab', () => {
    const all = items(macMenuTemplate('ClaudeTerm', () => {}))
    expect(all.some((i) => i.role === 'close' || i.role === 'fileMenu' || /\+W$/i.test(String(i.accelerator ?? '')))).toBe(false)
  })
})
