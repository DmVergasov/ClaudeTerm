export type KeyAction =
  | { type: 'newTab' }
  | { type: 'newClaudeTab' }
  | { type: 'closeTab' }
  | { type: 'nextTab' }
  | { type: 'prevTab' }
  | { type: 'gotoTab'; index: number }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'copyOrInterrupt' }
  | { type: 'smartPaste' }
  | { type: 'send'; data: string }
  | { type: 'find' }
  | { type: 'toggleImages' }
  | { type: 'toggleChanges' }
  | { type: 'zoomIn' }
  | { type: 'zoomOut' }
  | { type: 'zoomReset' }
  | { type: 'openSettings' }
  | { type: 'recentSessions' }

export interface KeyLike {
  type: string
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** What makes claude read an image from the clipboard: Alt+V in Claude Code on Windows, Ctrl+V elsewhere */
export function imagePasteInput(platform: string): string {
  return platform === 'win32' ? '\x1bv' : '\x16'
}

/** Ctrl on Windows and Linux, ⌘ on macOS, without the other modifiers: the key of a panel's own shortcuts (Ctrl+F, Ctrl+D) */
export function isPrimaryKey(e: KeyLike, platform: string): boolean {
  const mac = platform === 'darwin'
  return (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.shiftKey && !e.altKey
}

const LABELS = {
  newTab: ['Ctrl+Shift+T', '⌘T'],
  closeTab: ['Ctrl+Shift+W', '⌘W'],
  toggleImages: ['Ctrl+Shift+I', '⌘I'],
  toggleChanges: ['Ctrl+Shift+D', '⌘D'],
  panelFind: ['Ctrl+F', '⌘F'],
  star: ['Ctrl+D', '⌘D']
} as const

/** A shortcut as the platform writes it, for tooltips and hints */
export function shortcutLabel(name: keyof typeof LABELS, platform: string): string {
  return LABELS[name][platform === 'darwin' ? 1 : 0]
}

// Uses KeyboardEvent.code (physical key) so shortcuts work with any keyboard layout.
export function mapKey(e: KeyLike, platform: string): KeyAction | null {
  if (e.type !== 'keydown') return null
  if (platform === 'darwin') return mapMacKey(e)
  if (e.metaKey) return null
  const { ctrlKey: c, shiftKey: s, altKey: a, code } = e
  if (c && s && !a) {
    switch (code) {
      case 'KeyT': return { type: 'newTab' }
      case 'KeyL': return { type: 'newClaudeTab' }
      case 'KeyW': return { type: 'closeTab' }
      case 'KeyC': return { type: 'copy' }
      case 'KeyV': return { type: 'paste' }
      case 'KeyF': return { type: 'find' }
      case 'KeyI': return { type: 'toggleImages' }
      case 'KeyD': return { type: 'toggleChanges' }
      case 'KeyH': return { type: 'recentSessions' }
      case 'Tab': return { type: 'prevTab' }
    }
    return null
  }
  if (c && !s && !a) {
    switch (code) {
      case 'Tab': return { type: 'nextTab' }
      case 'KeyC': return { type: 'copyOrInterrupt' }
      case 'KeyV': return { type: 'smartPaste' }
      case 'Equal':
      case 'NumpadAdd': return { type: 'zoomIn' }
      case 'Minus':
      case 'NumpadSubtract': return { type: 'zoomOut' }
      case 'Digit0':
      case 'Numpad0': return { type: 'zoomReset' }
      case 'Comma': return { type: 'openSettings' }
    }
    return null
  }
  if (c && a && !s && /^Digit[1-9]$/.test(code)) return { type: 'gotoTab', index: Number(code.slice(5)) - 1 }
  if (s && !c && !a && (code === 'Enter' || code === 'NumpadEnter')) return { type: 'send', data: '\x1b\r' }
  return null
}

/**
 * macOS: ⌘ takes the place of Ctrl+Shift, since ⌘ never reaches the terminal; Ctrl keys go to the terminal as they are
 * (Ctrl+C interrupts, Ctrl+V is Claude Code's own image paste). ⌘H, ⌘M, ⌘Q and ⌘A are left to the system and the menu.
 */
function mapMacKey(e: KeyLike): KeyAction | null {
  const { metaKey: m, ctrlKey: c, shiftKey: s, altKey: a, code } = e
  if (m && !c && !a && !s) {
    switch (code) {
      case 'KeyT': return { type: 'newTab' }
      case 'KeyL': return { type: 'newClaudeTab' }
      case 'KeyW': return { type: 'closeTab' }
      case 'KeyC': return { type: 'copy' }
      case 'KeyV': return { type: 'smartPaste' }
      case 'KeyF': return { type: 'find' }
      case 'KeyI': return { type: 'toggleImages' }
      case 'KeyD': return { type: 'toggleChanges' }
      case 'Equal':
      case 'NumpadAdd': return { type: 'zoomIn' }
      case 'Minus':
      case 'NumpadSubtract': return { type: 'zoomOut' }
      case 'Digit0':
      case 'Numpad0': return { type: 'zoomReset' }
      case 'Comma': return { type: 'openSettings' }
    }
    if (/^Digit[1-9]$/.test(code)) return { type: 'gotoTab', index: Number(code.slice(5)) - 1 }
    return null
  }
  if (m && s && !c && !a) {
    switch (code) {
      case 'KeyV': return { type: 'paste' }
      case 'KeyH': return { type: 'recentSessions' }
      case 'BracketRight': return { type: 'nextTab' }
      case 'BracketLeft': return { type: 'prevTab' }
      // ⌘+ is ⌘⇧= on most layouts
      case 'Equal': return { type: 'zoomIn' }
    }
    return null
  }
  if (c && !m && !a && code === 'Tab') return { type: s ? 'prevTab' : 'nextTab' }
  if (s && !c && !a && !m && (code === 'Enter' || code === 'NumpadEnter')) return { type: 'send', data: '\x1b\r' }
  return null
}
