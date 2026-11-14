/**
 * A message as the composer sends it: each quote as blockquote lines (`> ` before every line of it), the quotes one after the
 * other, an empty line between them and before the typed text. A message with no typed text is the quotes alone.
 */
export function quoteMarkdown(quotes: string[], text: string): string {
  const blocks = quotes.map((quote) => quote.split(/\r?\n/).map((line) => `> ${line}`).join('\n'))
  return (text === '' ? blocks : [...blocks, text]).join('\n\n')
}

/**
 * The quotes a message starts with, as quoteMarkdown wrote them, and the typed text after them. A quote is lines that each start
 * with `> `, and it ends with an empty line or the end of the message. Any other line is the text: a `>>>` or a `>` with no space
 * is typed text, and so is a quote that a line other than an empty one follows. A message whose > comes later is all text.
 */
export function splitQuotes(text: string): { quotes: string[]; rest: string } {
  const lines = text.split('\n')
  const quotes: string[] = []
  let i = 0
  while (i < lines.length && lines[i]!.startsWith('> ')) {
    const start = i
    const block: string[] = []
    while (i < lines.length && lines[i]!.startsWith('> ')) block.push(lines[i++]!.slice(2))
    if (i < lines.length && lines[i] !== '') {
      i = start
      break
    }
    quotes.push(block.join('\n'))
    if (i === lines.length) break
    i++
  }
  return { quotes, rest: lines.slice(i).join('\n') }
}
