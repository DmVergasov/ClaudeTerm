import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
    expect(store.view()).toEqual({ profiles: [{ id: 'default', name: 'Default', allowed: [] }], defaultId: 'default' })
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
    expect(store.view()).toEqual({ profiles: [{ id: 'default', name: 'Default', allowed: [] }], defaultId: 'default' })
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
