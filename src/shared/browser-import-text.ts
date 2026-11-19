import type { ImportStatus } from './browser'

/** what the import sheet shows for one status of the import */
export interface ImportView {
  /** the text, one paragraph each */
  lines: string[]
  /** an import is under way, or the browser is asked something: From and Import are off */
  running: boolean
  /** a spinner shows: the browser or the import is working */
  busy: boolean
  /** Cancel is offered */
  cancel: boolean
  /** the browser profiles to choose from, when the import asks which one */
  choices: { contextId: string; label: string }[]
  /** the import has ended (done, failed or cancelled): From and Import are on again */
  final: boolean
}

const NOTHING: ImportView = { lines: [], running: false, busy: false, cancel: false, choices: [], final: false }

/** `1 cookie`, `2 cookies`: the noun in its singular for one, plural otherwise */
function count(n: number, noun: 'cookie' | 'site'): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`
}

/** the sheet's text, buttons and spinner for an import status: the strings are the ones the Global Constraints give */
export function importView(s: ImportStatus): ImportView {
  switch (s.state) {
    case 'idle':
      return NOTHING
    case 'waiting-close':
      return {
        ...NOTHING,
        lines: [`Close ${s.browser} to continue. The import starts as soon as it is closed.`, 'If it keeps running in the background, quit it from the tray icon.'],
        running: true,
        cancel: true,
      }
    case 'setup':
      return {
        ...NOTHING,
        lines: [`${s.browser} opened its remote debugging page. Turn on remote debugging there; the import goes on by itself.`],
        running: true,
        busy: true,
        cancel: true,
      }
    case 'allow':
      return { ...NOTHING, lines: [`Allow the connection in ${s.browser}.`], running: true, busy: true, cancel: true }
    case 'pick-profile':
      return {
        ...NOTHING,
        lines: [`Which ${s.browser} profile?`, `To import another profile, open a window of it in ${s.browser}.`],
        running: true,
        cancel: true,
        choices: s.profiles.map((p) => ({ contextId: p.contextId, label: p.label })),
      }
    case 'importing':
      return { ...NOTHING, running: true, busy: true, cancel: true }
    case 'done':
      return {
        ...NOTHING,
        lines: [`Imported ${count(s.imported, 'cookie')} for ${count(s.sites, 'site')}.`, ...s.notes],
        final: true,
      }
    case 'failed':
      return { ...NOTHING, lines: [s.error], final: true }
    case 'cancelled':
      return {
        ...NOTHING,
        lines: [s.imported !== undefined && s.imported > 0 ? `Cancelled. ${count(s.imported, 'cookie')} ${s.imported === 1 ? 'was' : 'were'} already imported.` : 'Cancelled.'],
        final: true,
      }
  }
}
