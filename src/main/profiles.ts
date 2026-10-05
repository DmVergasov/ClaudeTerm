import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { isUuid } from '../shared/protocol'
import type { ProfileDef, ShellFamily, TabKind } from '../shared/types'

export interface DetectDeps {
  exists(path: string): boolean
  env: Record<string, string | undefined>
  findInPath(exe: string): string | null
  listWslDistros(): string[]
}

export function detectProfiles(deps: DetectDeps): ProfileDef[] {
  const sysRoot = deps.env.SystemRoot ?? 'C:\\Windows'
  const progFiles = deps.env.ProgramFiles ?? 'C:\\Program Files'
  const out: ProfileDef[] = []

  const pwsh = deps.findInPath('pwsh.exe')
    ?? [win32.join(progFiles, 'PowerShell', '7', 'pwsh.exe'), win32.join(progFiles, 'PowerShell', '7-preview', 'pwsh.exe')].find((p) => deps.exists(p))
    ?? null
  if (pwsh) out.push({ name: 'PowerShell 7', command: pwsh, args: ['-NoLogo'] })

  const winPs = win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (deps.exists(winPs)) out.push({ name: 'Windows PowerShell', command: winPs, args: ['-NoLogo'] })

  const cmd = win32.join(sysRoot, 'System32', 'cmd.exe')
  if (deps.exists(cmd)) out.push({ name: 'Command Prompt', command: cmd, args: [] })

  const gitBash = win32.join(progFiles, 'Git', 'bin', 'bash.exe')
  if (deps.exists(gitBash)) out.push({ name: 'Git Bash', command: gitBash, args: ['--login', '-i'] })

  const wsl = win32.join(sysRoot, 'System32', 'wsl.exe')
  if (deps.exists(wsl)) {
    for (const distro of deps.listWslDistros()) out.push({ name: `WSL: ${distro}`, command: wsl, args: ['-d', distro] })
  }
  return out
}

export function mergeProfiles(detected: ProfileDef[], user: ProfileDef[]): ProfileDef[] {
  const result = detected.map((p) => user.find((u) => u.name === p.name) ?? p)
  for (const u of user) if (!detected.some((p) => p.name === u.name)) result.push(u)
  return result
}

/**
 * Splits profiles into those usable and those whose executable path is not on disk.
 * Only path-like commands are checked; bare names (pwsh.exe, wsl.exe) are resolved via PATH by the OS.
 */
export function filterAvailable(
  profiles: ProfileDef[],
  exists: (p: string) => boolean
): { available: ProfileDef[]; missing: ProfileDef[] } {
  const available: ProfileDef[] = []
  const missing: ProfileDef[] = []
  for (const p of profiles) {
    const isPath = win32.isAbsolute(p.command) || p.command.includes('\\') || p.command.includes('/')
    if (isPath && !exists(p.command)) missing.push(p)
    else available.push(p)
  }
  return { available, missing }
}

export function pickProfile(profiles: ProfileDef[], preferred: string | null): ProfileDef {
  if (preferred) {
    const p = profiles.find((x) => x.name === preferred)
    if (p) return p
  }
  const fallback = profiles.find((x) => x.name === 'PowerShell 7') ?? profiles.find((x) => x.name === 'Windows PowerShell') ?? profiles[0]
  if (!fallback) throw new Error('no shell profiles available')
  return fallback
}

export function shellFamily(p: ProfileDef): ShellFamily {
  const exe = win32.basename(p.command).toLowerCase().replace(/\.exe$/, '')
  if (exe === 'pwsh' || exe === 'powershell') return 'powershell'
  if (exe === 'cmd') return 'cmd'
  if (exe === 'wsl') return 'wsl'
  if (exe === 'bash') return 'bash'
  return 'other'
}

export function canHostClaude(p: ProfileDef): boolean {
  const f = shellFamily(p)
  return f === 'powershell' || f === 'cmd' || f === 'bash'
}

export function pickClaudeProfile(profiles: ProfileDef[], preferred: string | null): { profile: ProfileDef; warning: string | null } {
  const hostable = profiles.filter(canHostClaude)
  if (preferred) {
    const p = profiles.find((x) => x.name === preferred)
    if (p && canHostClaude(p)) return { profile: p, warning: null }
    const warning = p ? `Profile "${preferred}" cannot run claude; using default` : `Profile "${preferred}" not found; using default`
    return { profile: pickProfile(hostable, null), warning }
  }
  return { profile: pickProfile(hostable, null), warning: null }
}

export function quoteForShell(family: ShellFamily, value: string): string {
  switch (family) {
    case 'powershell':
      return `'${value.replace(/'/g, "''")}'`
    case 'cmd':
      return `"${value}"`
    case 'bash':
      return `'${value.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
    default:
      throw new Error(`cannot quote for shell family "${family}"`)
  }
}

export interface ClaudeLaunch {
  command: string
  settingsPath: string
  resumeSessionId: string | null
}

export function buildClaudeCommandLine(family: ShellFamily, c: ClaudeLaunch): string {
  let line = `${c.command} --settings ${quoteForShell(family, c.settingsPath)}`
  if (c.resumeSessionId !== null) {
    if (!isUuid(c.resumeSessionId)) throw new Error(`invalid session id: ${c.resumeSessionId}`)
    line += ` --resume ${c.resumeSessionId}`
  }
  return line
}

export interface LaunchSpec {
  file: string
  args: string[] | string
}

export function buildLaunch(profile: ProfileDef, kind: TabKind, claude: ClaudeLaunch | null): LaunchSpec {
  if (kind === 'shell') return { file: profile.command, args: profile.args }
  if (!claude) throw new Error('claude launch options are required for claude tabs')
  const family = shellFamily(profile)
  switch (family) {
    case 'powershell':
      return { file: profile.command, args: ['-NoLogo', '-NoExit', '-Command', buildClaudeCommandLine(family, claude)] }
    case 'cmd':
      // cmd.exe has its own quoting rules: pass a ready command line so node-pty does not re-escape quotes
      return { file: profile.command, args: `/k ${buildClaudeCommandLine(family, claude)}` }
    case 'bash':
      return { file: profile.command, args: ['--login', '-i', '-c', `${buildClaudeCommandLine(family, claude)}; exec bash --login -i`] }
    default:
      throw new Error(`profile "${profile.name}" cannot host claude`)
  }
}

export function parseWslList(buf: Buffer): string[] {
  const text = buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8')
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((s) => s.replace(/\0/g, '').trim())
    .filter((s) => s.length > 0)
}

export function systemDetectDeps(): DetectDeps {
  return {
    exists: existsSync,
    env: process.env,
    findInPath: (exe) => {
      try {
        const out = execFileSync('where.exe', [exe], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        return out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? null
      } catch {
        return null
      }
    },
    listWslDistros: () => {
      try {
        return parseWslList(execFileSync('wsl.exe', ['-l', '-q'], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }))
      } catch {
        return []
      }
    }
  }
}
