import { cutText } from './snapshot'

/** What the page looks like after a browser tool ran */
export interface PageFooter {
  url: string
  /** no title line when the page's title is not shown */
  title?: string
  newErrors: string[]
  downloads: string[]
  /** the downloads still running: their file names */
  running?: string[]
  dialogs: { type: string; message: string; answer: string }[]
}

const MAX_ERRORS = 5
const ERROR_LIMIT = 300
const MAX_DIALOGS = 5

/** the tool's text, then a `### Page` block with the URL, the title and what else changed */
export function withFooter(text: string, f: PageFooter): string {
  const lines = [text, '', '### Page', `- URL: ${f.url}`]
  if (f.title !== undefined) lines.push(`- Title: ${f.title}`)
  if (f.newErrors.length > 0) {
    lines.push(`- New console errors (${f.newErrors.length}):`)
    for (const error of f.newErrors.slice(0, MAX_ERRORS)) lines.push(`  - ${cutText(error, ERROR_LIMIT)}`)
  }
  if (f.downloads.length > 0) lines.push(`- Downloaded: ${f.downloads.join(', ')}`)
  for (const name of f.running ?? []) lines.push(`- Downloading: ${name}`)
  for (const d of f.dialogs.slice(0, MAX_DIALOGS)) {
    lines.push(`- Dialog: ${d.type} "${cutText(d.message, ERROR_LIMIT)}" → ${d.answer}`)
  }
  if (f.dialogs.length > MAX_DIALOGS) lines.push(`- …and ${f.dialogs.length - MAX_DIALOGS} more dialogs`)
  return lines.join('\n')
}
