import type { ITheme } from '@xterm/xterm'

export const THEMES: Record<string, ITheme> = {
  Graphite: {
    background: '#0E0E10', foreground: '#D4D4DA', cursor: '#D97757', cursorAccent: '#0E0E10', selectionBackground: '#FFFFFF30',
    black: '#1B1B1F', red: '#F2867E', green: '#63C08F', yellow: '#E5B567', blue: '#7FA7F5', magenta: '#A78BFA', cyan: '#6CC5D1', white: '#D4D4DA',
    brightBlack: '#85858F', brightRed: '#F7A39C', brightGreen: '#86D3A8', brightYellow: '#EECB8C', brightBlue: '#A3C0F8', brightMagenta: '#C0AAFC', brightCyan: '#93D7E0', brightWhite: '#EDEDF0'
  },
  Campbell: {
    background: '#0C0C0C', foreground: '#CCCCCC', cursor: '#FFFFFF', selectionBackground: '#FFFFFF40',
    black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', magenta: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
    brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightMagenta: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2'
  },
  'One Half Dark': {
    background: '#282C34', foreground: '#DCDFE4', cursor: '#A3B3CC', selectionBackground: '#FFFFFF40',
    black: '#282C34', red: '#E06C75', green: '#98C379', yellow: '#E5C07B', blue: '#61AFEF', magenta: '#C678DD', cyan: '#56B6C2', white: '#DCDFE4',
    brightBlack: '#5A6374', brightRed: '#E06C75', brightGreen: '#98C379', brightYellow: '#E5C07B', brightBlue: '#61AFEF', brightMagenta: '#C678DD', brightCyan: '#56B6C2', brightWhite: '#DCDFE4'
  },
  'One Half Light': {
    background: '#FAFAFA', foreground: '#383A42', cursor: '#4F525D', selectionBackground: '#00000030',
    black: '#383A42', red: '#E45649', green: '#50A14F', yellow: '#C18301', blue: '#0184BC', magenta: '#A626A4', cyan: '#0997B3', white: '#FAFAFA',
    brightBlack: '#4F525D', brightRed: '#DF6C75', brightGreen: '#98C379', brightYellow: '#E4C07A', brightBlue: '#61AFEF', brightMagenta: '#C577DD', brightCyan: '#56B5C1', brightWhite: '#FFFFFF'
  }
}

export function resolveTheme(theme: string | Record<string, string>): ITheme {
  if (typeof theme === 'string') return THEMES[theme] ?? THEMES.Graphite
  return { ...THEMES.Campbell, ...theme }
}

const GRAPHITE_BG = '#0E0E10'
const GRAPHITE_FG = '#D4D4DA'

/**
 * The colour tokens of a chat: the window's tokens the chat uses (set on the chat host, so the window's own stay as they are),
 * and the chat's surface, edge and text steps. Graphite's values are the ones the chat has always had.
 */
const GRAPHITE_CHAT: Record<string, string> = {
  '--bg': '#0E0E10', '--sheet': '#111114', '--raised': '#16161A', '--raised-2': '#1E1E23', '--line': '#1C1C21', '--line-2': '#2A2A31',
  '--border': '#2A2A31', '--text': '#EDEDF0', '--text-2': '#B5B5BE', '--text-3': '#8C8C96',
  '--red': '#F2867E', '--green': '#63C08F', '--amber': '#E5B567', '--blue': '#7FA7F5', '--purple': '#A78BFA',
  '--chat-tone-0': '#0C0C0E', '--chat-tone-1': '#0F0F12', '--chat-tone-2': '#131317', '--chat-tone-3': '#17171B', '--chat-tone-4': '#1A1A1F',
  '--chat-tone-5': '#1C1C22', '--chat-tone-6': '#1E1E24', '--chat-tone-7': '#22222A', '--chat-tone-8': '#24242B', '--chat-tone-9': '#26262D',
  '--chat-edge-2': '#202026', '--chat-edge-3': '#222228', '--chat-edge-6': '#2E2E36', '--chat-edge-7': '#4A4A54',
  '--chat-ink-1': '#9D9DA7', '--chat-ink-2': '#A3A3AC', '--chat-ink-3': '#DADADF', '--chat-ink-4': '#6E6E78',
  '--chat-on-accent': '#141414'
}

type Rgb = [number, number, number]

const rgbOf = (hex: string): Rgb => {
  const n = parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const hexOf = (c: Rgb): string => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`

/** a colour a theme writes as #rgb, #rgba, #rrggbb or #rrggbbaa (the alpha is left out); null for any other form, as rgb() or a name */
function parseHex(value: string | undefined): Rgb | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec((value ?? '').trim())
  if (m === null) return null
  const digits = m[1]!.length <= 4 ? [...m[1]!].map((d) => d + d).join('') : m[1]!
  return rgbOf(`#${digits.slice(0, 6)}`)
}

const mix = (a: Rgb, b: Rgb, p: number): Rgb => [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p, a[2] + (b[2] - a[2]) * p]

/** how far a Graphite token lies from Graphite's background towards its foreground: the same share of any theme's foreground gives it */
function shareOf(hex: string): number {
  const bg = rgbOf(GRAPHITE_BG)
  const fg = rgbOf(GRAPHITE_FG)
  const c = rgbOf(hex)
  let num = 0
  let den = 0
  for (let i = 0; i < 3; i++) {
    num += (c[i]! - bg[i]!) * (fg[i]! - bg[i]!)
    den += (fg[i]! - bg[i]!) ** 2
  }
  return Math.min(1, Math.max(0, num / den))
}

/**
 * The chat's colour tokens for a terminal theme. Graphite gives its own values; another theme mixes the chat's steps from its
 * background and foreground. On a light theme the status colours are the theme's own, which read on a light ground.
 */
export function chatPalette(theme: ITheme): Record<string, string> {
  // a colour the theme gives in a form that is not hex is not read: the Graphite one stands in for it
  const b = parseHex(theme.background) ?? rgbOf(GRAPHITE_BG)
  const f = parseHex(theme.foreground) ?? rgbOf(GRAPHITE_FG)
  const bg = hexOf(b)
  const fg = hexOf(f)
  if (bg === GRAPHITE_BG && fg === GRAPHITE_FG) return { ...GRAPHITE_CHAT, 'color-scheme': 'dark' }
  const palette: Record<string, string> = {}
  for (const [name, literal] of Object.entries(GRAPHITE_CHAT)) palette[name] = hexOf(mix(b, f, shareOf(literal)))
  palette['--bg'] = bg
  palette['--text'] = fg
  // the native scrollbars and form controls of the chat follow the theme's lightness, as the window's do not
  const light = (b[0] * 299 + b[1] * 587 + b[2] * 114) / 1000 > 128
  palette['color-scheme'] = light ? 'light' : 'dark'
  const status = (value: string | undefined, name: string): string => {
    const c = parseHex(value)
    return c === null ? GRAPHITE_CHAT[name]! : hexOf(c)
  }
  if (light) {
    palette['--red'] = status(theme.red, '--red')
    palette['--green'] = status(theme.green, '--green')
    palette['--amber'] = status(theme.yellow, '--amber')
    palette['--blue'] = status(theme.blue, '--blue')
    palette['--purple'] = status(theme.magenta, '--purple')
  } else {
    for (const name of ['--red', '--green', '--amber', '--blue', '--purple']) palette[name] = GRAPHITE_CHAT[name]!
  }
  return palette
}
