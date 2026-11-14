import { MAX_PATH_TEXT } from './remote'

/** a path as Claude wrote it: the file, and the line it names (null when none) */
export interface PathRef {
  path: string
  line: number | null
}

/** a path found in a text: where it is (start inclusive, end exclusive) and what it names */
export interface PathMatch {
  start: number
  end: number
  ref: PathRef
}

/** a path the window asked main about: `path` is the text it sent, `file` the absolute file */
export interface FileLink {
  path: string
  file: string
  kind: 'doc' | 'file'
  line: number | null
}

/** the most paths one chatFileLinks call answers */
export const MAX_FILE_LINKS = 200

/** characters a path token may start with, stripped before the shape is checked */
const LEADING = '([{"\'`<“‘'
/** characters a path token may end with, stripped before the shape is checked */
const TRAILING = '.,;:!?)]}"\'`>”’'

/** a URL scheme such as https: or mailto: (a drive letter is not one) */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const DRIVE = /^[A-Za-z]:[\\/]/
const SUFFIX = /^(.*?):(\d{1,7})(?:[:-]\d{1,7})?$/s
const FRAGMENT = /^L(\d{1,7})(?:-L?\d{1,7})?$/
const EXTENSION = /^[A-Za-z0-9_]{1,12}$/
const FORBIDDEN = /[*?<>|"\x00-\x1f\x7f]/

/** the path and line of a text with an optional :line, :line:col or :line-line suffix; line 0 is no line */
export function splitLine(text: string): PathRef {
  const m = SUFFIX.exec(text)
  if (!m) return { path: text, line: null }
  const line = Number(m[2])
  return { path: m[1], line: line > 0 ? line : null }
}

/** the path shape shared by the text and the link target: not a URL, no forbidden character, a last part with an extension */
function pathShape(path: string): boolean {
  if (path.length === 0 || FORBIDDEN.test(path)) return false
  if (SCHEME.test(path) && !DRIVE.test(path)) return false
  const last = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = last.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = last.slice(dot + 1)
  return EXTENSION.test(ext) && /[A-Za-z]/.test(ext)
}

/** every path in a text: a whitespace-separated token with a folder separator, outside its surrounding punctuation */
export function findPaths(text: string): PathMatch[] {
  const found: PathMatch[] = []
  for (const token of text.matchAll(/\S+/g)) {
    if (token[0].length > MAX_PATH_TEXT) continue
    let start = token.index
    let end = token.index + token[0].length
    while (start < end && LEADING.includes(text[start])) start++
    while (end > start && TRAILING.includes(text[end - 1])) end--
    const core = text.slice(start, end)
    if (!core.includes('/') && !core.includes('\\')) continue
    const ref = splitLine(core)
    if (!pathShape(ref.path)) continue
    found.push({ start, end, ref })
  }
  return found
}

/** the path a Markdown link target names, or null when it is not a file (a web address, an anchor, a folder) */
export function linkPath(target: string): PathRef | null {
  if (target.length > MAX_PATH_TEXT) return null
  const hash = target.indexOf('#')
  const head = hash < 0 ? target : target.slice(0, hash)
  const fragment = hash < 0 ? null : FRAGMENT.exec(target.slice(hash + 1))
  const ref = splitLine(head)
  if (!pathShape(ref.path)) return null
  const fragmentLine = fragment ? Number(fragment[1]) : 0
  return { path: ref.path, line: fragmentLine > 0 ? fragmentLine : ref.line }
}

/** the text a path reference reads as: its path, with :line after it when it has one */
export function pathRefText(ref: PathRef): string {
  return ref.line === null ? ref.path : `${ref.path}:${ref.line}`
}
