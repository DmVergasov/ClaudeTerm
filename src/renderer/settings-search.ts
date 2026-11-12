// What the Settings search matches, kept apart from the DOM.

// The words of a query: lower case, split on white space, none for a blank query.
export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((word) => word !== '')
}

// True when every word appears somewhere in the text, case ignored.
export function matchesQuery(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return words.every((word) => lower.includes(word))
}

// Where the words are in the text, as [start, end) pairs in order; overlapping or touching ranges are merged.
export function matchRanges(text: string, words: readonly string[]): [number, number][] {
  const lower = text.toLowerCase()
  const found: [number, number][] = []
  for (const word of words) {
    if (word === '') continue
    let index = lower.indexOf(word)
    while (index !== -1) {
      found.push([index, index + word.length])
      index = lower.indexOf(word, index + 1)
    }
  }
  found.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [start, end] of found) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

// The result count shown above the settings: none, one, many.
export function countLabel(n: number): string {
  if (n === 0) return 'No settings'
  return n === 1 ? '1 setting' : `${n} settings`
}
