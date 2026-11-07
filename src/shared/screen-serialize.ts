/**
 * serialize(n) with n scrollback lines, starting from the lines the buffer holds (`bufferLines`, at most `scrollback`) and
 * scaled down while the JSON of the text is over maxBytes; at 0 it returns serialize(0) whatever its size
 */
export function boundedSerialize(serialize: (scrollback: number) => string, scrollback: number, maxBytes: number, bufferLines = scrollback): string {
  let n = Math.max(0, Math.min(scrollback, bufferLines))
  for (;;) {
    const text = serialize(n)
    if (n === 0) return text
    const bytes = new TextEncoder().encode(JSON.stringify(text)).length
    if (bytes <= maxBytes) return text
    n = Math.max(0, Math.min(n - 1, Math.floor((n * maxBytes) / bytes * 0.9)))
  }
}

/**
 * The scrollback lines a terminal holds above its screen, in the normal buffer: the serialize addon limits only that buffer,
 * and a program in the alternate screen (vim, less) leaves the active buffer as long as the screen.
 */
export function scrollbackLines(term: { buffer: { normal: { length: number } }; rows: number }): number {
  return Math.max(0, term.buffer.normal.length - term.rows)
}
