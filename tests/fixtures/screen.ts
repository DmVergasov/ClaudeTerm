import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { RemoteSnapshot } from '../../src/shared/remote'

/** a fresh headless terminal with the window's wide-character table (Unicode 11) */
export function headless(cols: number, rows: number, scrollback = 10_000): Terminal {
  const t = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  t.loadAddon(new Unicode11Addon())
  t.unicode.activeVersion = '11'
  return t
}

/** a headless terminal fed `data`, resolved once everything is parsed */
export function fed(cols: number, rows: number, data: string): Promise<Terminal> {
  const t = headless(cols, rows)
  return new Promise((resolve) => t.write(data, () => resolve(t)))
}

/** a fresh terminal of the snapshot's size, fed the snapshot's data */
export function replay(s: RemoteSnapshot): Promise<Terminal> {
  return fed(s.cols, s.rows, s.data)
}

/** every buffer line, trimmed at the right */
export function textOf(t: Terminal): string[] {
  const buf = t.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  return lines
}

/** lines `line 0` .. `line n-1`, each ended with CRLF */
export function numbered(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}\r\n`).join('')
}
