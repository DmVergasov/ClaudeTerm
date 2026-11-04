import { readFile, stat } from 'node:fs/promises'
import { docKindOf, DOC_TYPES, type DocKind, type DocRead, MAX_DOC_BYTES } from './docs'

export type DocCheck = { ok: true; kind: DocKind; size: number } | { ok: false; error: string }

type DocStat = { ok: true; kind: DocKind; size: number; mtimeMs: number } | { ok: false; error: string }

async function statDoc(path: string): Promise<DocStat> {
  const kind = docKindOf(path)
  if (kind === null) return { ok: false, error: `not a supported document type (${DOC_TYPES}): ${path}` }
  let st
  try {
    st = await stat(path)
  } catch {
    return { ok: false, error: `file not found: ${path}` }
  }
  if (!st.isFile()) return { ok: false, error: `not a file: ${path}` }
  if (st.size > MAX_DOC_BYTES[kind]) return { ok: false, error: `the document is larger than ${MAX_DOC_BYTES[kind] / 1024 / 1024} MB: ${path}` }
  return { ok: true, kind, size: st.size, mtimeMs: st.mtimeMs }
}

export async function checkDocFile(path: string): Promise<DocCheck> {
  const r = await statDoc(path)
  return r.ok ? { ok: true, kind: r.kind, size: r.size } : r
}

// Markdown only: the text is read for the Docs panel, with the stamp of the file it was checked against.
export async function readDocText(path: string): Promise<DocRead> {
  const r = await statDoc(path)
  if (!r.ok) return r
  if (r.kind !== 'markdown') return { ok: false, error: `not a Markdown document: ${path}` }
  const text = await readFile(path, 'utf8')
  return { ok: true, text: text.startsWith('\uFEFF') ? text.slice(1) : text, stamp: `${r.mtimeMs}:${r.size}` }
}

/** The file's mtime and size as one string, to see whether it changed; null when it is not a regular file. */
export async function docStamp(path: string): Promise<string | null> {
  try {
    const st = await stat(path)
    return st.isFile() ? `${st.mtimeMs}:${st.size}` : null
  } catch {
    return null
  }
}
