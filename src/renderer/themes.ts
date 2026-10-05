import type { ITheme } from '@xterm/xterm'

export const THEMES: Record<string, ITheme> = {
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
  if (typeof theme === 'string') return THEMES[theme] ?? THEMES.Campbell
  return { ...THEMES.Campbell, ...theme }
}
