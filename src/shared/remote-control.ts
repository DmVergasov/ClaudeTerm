/** What a Claude tab shows of Remote Control: off, starting, live at a claude.ai link, or stopped with a reason */
export type RemoteState =
  | { kind: 'off' }
  | { kind: 'connecting'; note?: string; waits?: true }
  | { kind: 'on'; url: string; leaving?: true; waits?: true }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string }

/** a session or bridge id as claude.ai issues it: only letters, digits, _ and -, up to 128 of them */
export const isBridgeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)

/** the page a phone or browser opens to continue the session */
export function remoteLink(id: string): string {
  return `https://claude.ai/code/${id}`
}

/** the longest name a Remote Control session gets, in code points */
export const REMOTE_NAME_MAX = 60

/**
 * The name a Remote Control session shows: the tab's title as Claude Code shows it, without the spinner mark,
 * control characters and leading dashes, and never empty
 */
export function remoteName(title: string): string {
  const named = title
    .replace(/^[✳◐◑] (?=\S)/, '')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .replace(/^[-\s]+/, '')
    .trim()
  return Array.from(named).slice(0, REMOTE_NAME_MAX).join('').trim() || 'ClaudeTerm'
}

/** why Remote Control cannot be used, in the words the user reads */
export const REMOTE_REASONS = {
  token: 'This account signs in with a token: Remote Control needs a claude.ai sign-in',
  baseUrl: "Remote Control needs Anthropic's own service: this account uses ANTHROPIC_BASE_URL",
  noSignIn: 'No claude.ai sign-in found for this account',
  bridgeChanged: "This ClaudeTerm cannot host Remote Control: the Agent SDK's bridge changed",
  relogin: 'Sign in to this account again (claude auth login)',
  untrustedDevice: 'Turn Remote Control on once in a terminal tab of this account: Claude Code registers this computer then',
  unreachable: 'claude.ai could not be reached'
}

export function refusedReason(status: number): string {
  return `claude.ai refused Remote Control (${status})`
}

/** shown under a Claude tab while Claude Code renews the sign-in that Remote Control uses */
export const RENEW_WAIT_NOTE = "Waiting for Claude Code to renew this account's sign-in"

export function connectTimeoutToast(tab: string): string {
  return `Remote Control did not connect in ${tab}: see the terminal`
}
