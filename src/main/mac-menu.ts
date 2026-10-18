import type { MenuItemConstructorOptions } from 'electron'

/**
 * The menu bar of macOS, where every app has one: without it ⌘Q, ⌘H and ⌘M do nothing and text fields have no ⌘C,
 * ⌘V or ⌘A. The window's own shortcuts (⌘T, ⌘W, ⌘C in a terminal) are handled by the page, which gets a key before
 * the menu does. There is no Close item: ⌘W typed in a text field would close the window instead of the tab.
 */
export function macMenuTemplate(appName: string, openSettings: () => void): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => openSettings() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]
}
