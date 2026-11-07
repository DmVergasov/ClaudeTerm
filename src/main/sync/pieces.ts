// Text cut into pieces for the wire: the output of a tab and the input typed into it.

/** the text cut into pieces of at most `max` characters; a cut that would fall between the two halves of a surrogate pair moves one unit earlier */
export function piecesOf(data: string, max: number): string[] {
  const pieces: string[] = []
  let start = 0
  while (start < data.length) {
    let end = Math.min(data.length, start + max)
    if (end < data.length && end - 1 > start && isHighSurrogate(data.charCodeAt(end - 1))) end--
    pieces.push(data.slice(start, end))
    start = end
  }
  return pieces
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}
