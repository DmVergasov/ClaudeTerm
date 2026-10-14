/**
 * The text an OSC 52 sequence ("<targets>;<base64>") copies to the clipboard, or null. Programs may write the
 * clipboard but never read it: a query ("?") is ignored, as are targets other than the clipboard.
 */
export function osc52Text(data: string): string | null {
  const sep = data.indexOf(';')
  if (sep < 0) return null
  const targets = data.slice(0, sep)
  const payload = data.slice(sep + 1)
  if (targets !== '' && !targets.includes('c')) return null
  if (payload === '' || payload === '?') return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0)))
  } catch {
    return null
  }
}
