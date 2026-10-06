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

// Uses KeyboardEvent.code (physical key) so shortcuts work with any keyboard layout.
export function mapKey(e: KeyLike): KeyAction | null {
  if (e.type !== 'keydown' || e.metaKey) return null
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
