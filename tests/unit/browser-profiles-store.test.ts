import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserProfilesStore } from '../../src/main/browser/profiles-store'
import { PROFILE_ID_RE } from '../../src/shared/browser'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ct-bprof-')), 'browser-profiles.json')
}

describe('BrowserProfilesStore', () => {
  it('refuses a name with a control character or a bidi override, and leaves the view unchanged', () => {
    const store = new BrowserProfilesStore(tempFile())
    const before = store.view()
    for (const bad of ['a\nb', '\u0000x', 'x‮y', 'x⁦y']) {
      expect(store.add(bad)).toBeNull()
    }
    expect(store.view()).toEqual(before)
    const id = store.add('Work') as string
    for (const bad of ['a\nb', '\u0000x', 'x‮y']) expect(store.rename(id, bad)).toBe(false)
    expect(store.name(id)).toBe('Work')
  })

  it('starts with the Default profile only', () => {
    const store = new BrowserProfilesStore(tempFile())
    expect(store.view()).toEqual({ profiles: [{ id: 'default', name: 'Default', allowed: [], allowAll: false }], defaultId: 'default' })
  })

  it('keeps the always-allow-all switch per profile, off for a new profile, and saves only a change', () => {
    const file = tempFile()
    const store = new BrowserProfilesStore(file)
    const work = store.add('Work') as string
    expect(store.view().profiles.find((p) => p.id === work)).toEqual({ id: work, name: 'Work', allowed: [], allowAll: false })
    expect(store.setAllowAll('default', true)).toBe(true)
    expect(new BrowserProfilesStore(file).allowsAll('default')).toBe(true)
    expect(new BrowserProfilesStore(file).allowsAll(work)).toBe(false)
    expect(store.setAllowAll('default', true)).toBe(false)
    expect(store.setAllowAll('unknown', true)).toBe(false)
    expect(store.allowsAll('unknown')).toBe(false)
  })

  it('writes a profile whose allowAll was not true back as off, on the next save', () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ version: 1, defaultId: 'default', profiles: [{ id: 'default', name: 'Default', allowed: [], allowAll: 'yes' }] }), 'utf8')
    new BrowserProfilesStore(file).add('Work')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { profiles: { id: string; allowAll: unknown }[] }
    expect(saved.profiles.find((p) => p.id === 'default')?.allowAll).toBe(false)
  })

  it('setAllowAll with the value the profile already has does not rewrite the file', () => {
    const file = tempFile()
    const store = new BrowserProfilesStore(file)
    expect(store.setAllowAll('default', true)).toBe(true)
    const past = new Date('2001-01-01T00:00:00Z')
    utimesSync(file, past, past)
    expect(store.setAllowAll('default', true)).toBe(false)
    expect(statSync(file).mtimeMs).toBe(past.getTime())
  })

  it('setAllowAll on a removed profile returns false and changes no other profile', () => {
    const store = new BrowserProfilesStore(tempFile())
    const work = store.add('Work') as string
    expect(store.remove(work)).toBe(true)
    expect(store.setAllowAll(work, true)).toBe(false)
    expect(store.allowsAll('default')).toBe(false)
    expect(store.view().profiles.map((p) => p.id)).toEqual(['default'])
  })

  it('loads a profile with no allowAll, or one that is not true, as off', () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ version: 1, defaultId: 'default', profiles: [{ id: 'default', name: 'Default', allowed: [] }] }), 'utf8')
    expect(new BrowserProfilesStore(file).allowsAll('default')).toBe(false)
    writeFileSync(file, JSON.stringify({ version: 1, defaultId: 'default', profiles: [{ id: 'default', name: 'Default', allowed: [], allowAll: 'yes' }] }), 'utf8')
    expect(new BrowserProfilesStore(file).allowsAll('default')).toBe(false)
  })

  it('keeps an added profile in its file for the next store', () => {
    const file = tempFile()
    const id = new BrowserProfilesStore(file).add('Work')
    expect(id).not.toBeNull()
    expect(id).toMatch(PROFILE_ID_RE)
    expect(new BrowserProfilesStore(file).name(id as string)).toBe('Work')
  })

  it('refuses a duplicate name ignoring case, an empty name and a name over 40 characters', () => {
    const store = new BrowserProfilesStore(tempFile())
    expect(store.add('Work')).not.toBeNull()
    expect(store.add('work')).toBeNull()
    expect(store.add('')).toBeNull()
    expect(store.add('x'.repeat(41))).toBeNull()
  })

  it('never removes the default profile', () => {
    const store = new BrowserProfilesStore(tempFile())
    expect(store.remove('default')).toBe(false)
    expect(store.has('default')).toBe(true)
  })

  it('makes Default the default again when the default profile is removed', () => {
    const store = new BrowserProfilesStore(tempFile())
    const id = store.add('Work') as string
    expect(store.setDefault(id)).toBe(true)
    expect(store.defaultId()).toBe(id)
    expect(store.remove(id)).toBe(true)
    expect(store.defaultId()).toBe('default')
  })

  it('keeps one entry when a site is allowed twice, and removes it on disallow', () => {
    const store = new BrowserProfilesStore(tempFile())
    const id = store.add('Work') as string
    store.allow(id, 'github.com')
    store.allow(id, 'github.com')
    expect(store.allowed(id)).toEqual(['github.com'])
    expect(store.disallow(id, 'github.com')).toBe(true)
    expect(store.allowed(id)).toEqual([])
  })

  it('loads a file whose profiles are not a list as Default only and reports the error', () => {
    const file = tempFile()
    writeFileSync(file, '{"version":1,"profiles":"x"}', 'utf8')
    const errors: string[] = []
    const store = new BrowserProfilesStore(file, { onError: (m) => errors.push(m) })
    expect(store.view()).toEqual({ profiles: [{ id: 'default', name: 'Default', allowed: [], allowAll: false }], defaultId: 'default' })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('writes the file through a temporary file and in the documented format', () => {
    const file = tempFile()
    new BrowserProfilesStore(file).add('Work')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { version: number; defaultId: string; profiles: unknown[] }
    expect(saved.version).toBe(1)
    expect(saved.defaultId).toBe('default')
    expect(saved.profiles).toHaveLength(2)
  })
})
