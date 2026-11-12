import { join, win32 } from 'node:path'
import { nativePath, isWindowsPath, pathKey } from '../path-key'
import { versionAtLeast } from '../claude-version'
import type { ChatLaunch } from './claude-spawn'

/** the oldest Claude Code a chat tab runs on (tests/fixtures/chat/README.md, "Version floor") */
export const CHAT_MIN_CLAUDE_VERSION = '2.1.322'

/** a .claude.json larger than this is not read: its trust list is small, a huge file is not one Claude Code wrote */
const MAX_TRUST_BYTES = 16 * 1024 * 1024

/** the reason a Claude tab cannot chat when the command's version is unknown or too old, or null when it can */
export function versionBlock(command: string, version: string | null): string | null {
  if (version === null) {
    return `Chat needs Claude Code ${CHAT_MIN_CLAUDE_VERSION} or later, and the version of "${command}" could not be read; the tab opened in the terminal`
  }
  if (!versionAtLeast(version, CHAT_MIN_CLAUDE_VERSION)) {
    return `Chat needs Claude Code ${CHAT_MIN_CLAUDE_VERSION} or later (this is ${version}); the tab opened in the terminal`
  }
  return null
}

/**
 * The folders the text of .claude.json trusts (`projects[folder].hasTrustDialogAccepted`), as Claude Code wrote the keys.
 * The file is Claude Code's and its format is not documented: a file that is too big, not JSON or shaped otherwise
 * trusts nothing, and nothing here throws.
 */
export function trustedFolders(claudeJson: string): string[] {
  if (Buffer.byteLength(claudeJson, 'utf8') > MAX_TRUST_BYTES) return []
  let data: unknown
  try {
    data = JSON.parse(claudeJson)
  } catch {
    return []
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return []
  const projects = (data as Record<string, unknown>).projects
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) return []
  return Object.entries(projects)
    .filter(([, entry]) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).hasTrustDialogAccepted === true)
    .map(([key]) => key)
}

/** whether one of the trusted folders is the folder or one of its parents */
export function isTrustedIn(trusted: string[], folder: string): boolean {
  // a Windows folder compares with win32 rules, so C:/Work/Acme and c:\work\acme\src agree
  const path = isWindowsPath(folder) ? win32 : nativePath
  const keys = new Set(trusted.map((key) => pathKey(key, path)))

  let current = pathKey(folder, path)
  for (;;) {
    if (keys.has(current)) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/** whether Claude Code has accepted the trust dialog for the folder or for one of its parents, read from the text of .claude.json */
export function isTrusted(claudeJson: string, folder: string): boolean {
  return isTrustedIn(trustedFolders(claudeJson), folder)
}

/** what a stat of .claude.json says about its version: a changed time or size means it was written since */
export interface TrustFileStat {
  mtimeMs: number
  size: number
}

export interface TrustFileSource {
  stat(file: string): Promise<TrustFileStat | null>
  /** the text of the file, or null when it cannot be read */
  read(file: string): Promise<string | null>
}

/**
 * The trusted folders of .claude.json, parsed once per version of the file: ten restored chat tabs start with one parse.
 * The file is stat'ed at each call, and read and parsed again only when its mtime or size has changed.
 */
export function cachedTrustList(source: TrustFileSource): (file: string) => Promise<string[] | null> {
  const parsed = new Map<string, { stat: TrustFileStat; trusted: string[] }>()
  return async (file) => {
    const stat = await source.stat(file)
    if (stat === null) return null
    const hit = parsed.get(file)
    if (hit !== undefined && hit.stat.mtimeMs === stat.mtimeMs && hit.stat.size === stat.size) return hit.trusted
    const text = await source.read(file)
    if (text === null) return null
    const trusted = trustedFolders(text)
    parsed.set(file, { stat, trusted })
    return trusted
  }
}

/** the .claude.json Claude Code reads: in CLAUDE_CONFIG_DIR when it is set, else in the home folder */
export function trustFile(env: Record<string, string | undefined>, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR || home, '.claude.json')
}

export interface ChatSupportDeps {
  version(command: string): Promise<string | null>
  /** the folders the trust file trusts, or null when it cannot be read (cachedTrustList) */
  readTrust(file: string): Promise<string[] | null>
  launch(command: string): Promise<ChatLaunch>
  home: string
}

/**
 * Whether a Claude tab in `folder` can chat, and how it starts if so. The checks run in order: the command starts without
 * a terminal, its version is at the floor, the folder is trusted. The first one that fails gives the reason shown to the
 * user, and the tab opens in the terminal. A failed version probe or trust read counts as unknown; `launch` is expected not
 * to reject (resolveChatLaunch never does).
 */
export async function chatSupport(
  command: string,
  folder: string,
  env: Record<string, string | undefined>,
  deps: ChatSupportDeps
): Promise<{ launch: Exclude<ChatLaunch, { how: 'none' }> } | { reason: string }> {
  const launch = await deps.launch(command)
  if (launch.how === 'none') return { reason: `${launch.reason}; the tab opened in the terminal` }

  let version: string | null = null
  try {
    version = await deps.version(command)
  } catch {
    // a probe that fails leaves the version unknown
  }
  const versionReason = versionBlock(command, version)
  if (versionReason !== null) return { reason: versionReason }

  let trusted: string[] | null = null
  try {
    trusted = await deps.readTrust(trustFile(env, deps.home))
  } catch {
    // an unreadable file trusts nothing
  }
  if (trusted === null || !isTrustedIn(trusted, folder)) {
    return { reason: `Claude Code has not been told to trust ${folder} yet; the tab opened in the terminal for its trust question` }
  }
  return { launch }
}
