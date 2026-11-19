import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DEFAULT_PROFILE_ID, MAX_PROFILE_NAME, PROFILE_ID_RE, UNSAFE_PROFILE_NAME } from '../../shared/browser'
import type { BrowserProfilesView } from '../../shared/browser'

interface StoredProfile { id: string; name: string; allowed: string[]; allowAll: boolean }

export interface BrowserProfilesStoreOptions {
  onError?(message: string): void
  newId?(): string
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 8 random characters from a-z and 0-9 */
function randomId(): string {
  return Array.from(randomBytes(8), (b) => ID_CHARS[b % ID_CHARS.length]).join('')
}

/** a profile name trimmed to 1 to MAX_PROFILE_NAME characters, or null; a name with a control character or a bidi override is refused */
function cleanName(name: string): string | null {
  if (UNSAFE_PROFILE_NAME.test(name)) return null
  const t = name.trim()
  return t.length >= 1 && t.length <= MAX_PROFILE_NAME ? t : null
}

/**
 * The browser's profiles: each one is its own session with its own cookies, and keeps its own list of
 * always-allowed sites. Kept in a JSON file; a missing or broken file starts with Default only.
 */
export class BrowserProfilesStore {
  private profiles: StoredProfile[] = []
  private defaultProfileId: string = DEFAULT_PROFILE_ID
  private readonly newId: () => string

  constructor(private readonly file: string, private readonly opts: BrowserProfilesStoreOptions = {}) {
    this.newId = opts.newId ?? randomId
    this.load()
  }

  view(): BrowserProfilesView {
    return {
      profiles: this.profiles.map((p) => ({ id: p.id, name: p.name, allowed: [...p.allowed], allowAll: p.allowAll })),
      defaultId: this.defaultProfileId
    }
  }

  has(id: string): boolean {
    return this.find(id) !== undefined
  }

  name(id: string): string | null {
    return this.find(id)?.name ?? null
  }

  defaultId(): string {
    return this.defaultProfileId
  }

  /** adds a profile with a new id and returns the id; null when the name is not allowed */
  add(name: string): string | null {
    const clean = cleanName(name)
    if (clean === null || this.nameTaken(clean)) return null
    let id = this.newId()
    while (this.has(id)) id = this.newId()
    this.profiles.push({ id, name: clean, allowed: [], allowAll: false })
    this.save()
    return id
  }

  rename(id: string, name: string): boolean {
    const profile = this.find(id)
    const clean = cleanName(name)
    if (!profile || clean === null || this.nameTaken(clean, id)) return false
    profile.name = clean
    this.save()
    return true
  }

  /** removes a profile; the default profile is never removed, and removing the default makes Default the default */
  remove(id: string): boolean {
    if (id === DEFAULT_PROFILE_ID || !this.has(id)) return false
    this.profiles = this.profiles.filter((p) => p.id !== id)
    if (this.defaultProfileId === id) this.defaultProfileId = DEFAULT_PROFILE_ID
    this.save()
    return true
  }

  setDefault(id: string): boolean {
    if (!this.has(id)) return false
    this.defaultProfileId = id
    this.save()
    return true
  }

  /** the always-allowed sites of a profile, sorted; empty for an unknown profile */
  allowed(id: string): string[] {
    return [...(this.find(id)?.allowed ?? [])].sort()
  }

  /** whether the profile allows every web site without asking; false for an unknown profile */
  allowsAll(id: string): boolean {
    return this.find(id)?.allowAll === true
  }

  /** turns the always-allow-all switch of a profile on or off; false for an unknown profile or no change */
  setAllowAll(id: string, on: boolean): boolean {
    const profile = this.find(id)
    if (!profile || profile.allowAll === on) return false
    profile.allowAll = on
    this.save()
    return true
  }

  allow(id: string, site: string): void {
    const profile = this.find(id)
    if (!profile || profile.allowed.includes(site)) return
    profile.allowed.push(site)
    this.save()
  }

  disallow(id: string, site: string): boolean {
    const profile = this.find(id)
    if (!profile || !profile.allowed.includes(site)) return false
    profile.allowed = profile.allowed.filter((s) => s !== site)
    this.save()
    return true
  }

  private find(id: string): StoredProfile | undefined {
    return this.profiles.find((p) => p.id === id)
  }

  /** true when another profile (not the one with exceptId) already has the name, ignoring case */
  private nameTaken(name: string, exceptId?: string): boolean {
    const lower = name.toLowerCase()
    return this.profiles.some((p) => p.id !== exceptId && p.name.toLowerCase() === lower)
  }

  private load(): void {
    this.profiles = [{ id: DEFAULT_PROFILE_ID, name: 'Default', allowed: [], allowAll: false }]
    if (!existsSync(this.file)) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      this.opts.onError?.(`ignoring corrupt ${this.file}`)
      return
    }
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (r.version !== 1 || !Array.isArray(r.profiles)) {
      this.opts.onError?.(`ignoring corrupt ${this.file}`)
      return
    }
    const loaded: StoredProfile[] = []
    for (const item of r.profiles as unknown[]) {
      if (typeof item !== 'object' || item === null) continue
      const p = item as Record<string, unknown>
      if (typeof p.id !== 'string' || !PROFILE_ID_RE.test(p.id) || loaded.some((x) => x.id === p.id)) continue
      const name = typeof p.name === 'string' ? cleanName(p.name) : null
      if (name === null || loaded.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue
      const allowed = Array.isArray(p.allowed) ? [...new Set(p.allowed.filter((s): s is string => typeof s === 'string' && s.length > 0))] : []
      loaded.push({ id: p.id, name, allowed, allowAll: p.allowAll === true })
    }
    if (!loaded.some((p) => p.id === DEFAULT_PROFILE_ID)) loaded.unshift({ id: DEFAULT_PROFILE_ID, name: 'Default', allowed: [], allowAll: false })
    this.profiles = loaded
    const wanted = typeof r.defaultId === 'string' ? r.defaultId : DEFAULT_PROFILE_ID
    this.defaultProfileId = loaded.some((p) => p.id === wanted) ? wanted : DEFAULT_PROFILE_ID
  }

  private save(): void {
    const data = { version: 1, defaultId: this.defaultProfileId, profiles: this.profiles }
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      this.opts.onError?.(`cannot save browser profiles: ${(e as Error).message}`)
    }
  }
}
