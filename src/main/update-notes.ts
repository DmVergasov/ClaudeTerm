import type { ReleaseNotes } from '../shared/types'

// the notes come from the update feed: as much as the banner lists at most
const MAX_INPUT = 100_000
const MAX_VERSIONS = 10
const MAX_ITEMS = 20
const MAX_TITLE = 120
const MAX_TEXT = 1000

type Version = [number, number, number]

const HEADING = /^## (\d+)\.(\d+)\.(\d+)(?:\s|$)/

function parseVersion(v: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return 0
}

/** markdown as plain text: no bold or code marks, a link's text without its address */
function plain(md: string): string {
  return md.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

/** the item's first sentence, or what comes before a colon, without the mark that ends it */
function headline(text: string): string {
  const end = /[.!?:](?=\s|$)/.exec(text)
  return cut(end ? text.slice(0, end.index) : text, MAX_TITLE)
}

/**
 * What changed after the installed version up to the downloaded one, newest first, from the sections of CHANGELOG.md
 * the update feed carries (`## 0.4.0`, then `- ` items). Notes in any other form (the HTML of GitHub's release feed) give none.
 */
export function parseUpdateNotes(notes: unknown, current: string, latest: string): ReleaseNotes[] {
  const from = parseVersion(current)
  const to = parseVersion(latest)
  if (typeof notes !== 'string' || !from || !to) return []
  const sections: { v: Version; items: string[] }[] = []
  let items: string[] | null = null
  for (const line of notes.slice(0, MAX_INPUT).split(/\r?\n/)) {
    const h = HEADING.exec(line)
    if (h) {
      items = []
      sections.push({ v: [Number(h[1]), Number(h[2]), Number(h[3])], items })
    } else if (!items) {
      continue
    } else if (line.startsWith('- ')) {
      items.push(line.slice(2))
    } else if (/^\s+\S/.test(line) && items.length > 0) {
      // an item wrapped onto the next line
      items[items.length - 1] += ` ${line.trim()}`
    }
  }
  return sections
    .filter((s) => compare(s.v, from) > 0 && compare(s.v, to) <= 0)
    .map((s) => ({ v: s.v, items: s.items.map(plain).filter((t) => t !== '') }))
    .filter((s) => s.items.length > 0)
    .sort((a, b) => compare(b.v, a.v))
    .slice(0, MAX_VERSIONS)
    .map((s) => ({ version: s.v.join('.'), items: s.items.slice(0, MAX_ITEMS).map((text) => ({ title: headline(text), text: cut(text, MAX_TEXT) })) }))
}
