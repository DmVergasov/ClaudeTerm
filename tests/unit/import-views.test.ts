import { describe, expect, it } from 'vitest'
import { sourceViews, type ImportSource } from '../../src/main/browser-import/sources'
import { importSectionProfile } from '../../src/shared/ipc'

// Invented sources only: the folders are placeholders, nothing is read from disk.
function source(over: Partial<ImportSource>): ImportSource {
  return {
    id: 'chromium:Default',
    kind: 'chromium',
    browser: 'Chromium',
    label: 'Chromium · Personal',
    family: 'chromium',
    userDataDir: '/fake/Chromium',
    profileDir: '/fake/Chromium/Default',
    profileName: 'Personal',
    email: null,
    hasCookies: true,
    binary: { file: '/fake/chromium', args: [] },
    mode: 'copy',
    ...over,
  }
}

describe('sourceViews', () => {
  it('lists each source with its id and label, available when it has cookies and a browser to read them', () => {
    const views = sourceViews([
      source({}),
      source({ id: 'chromium:Profile 1', label: 'Chromium · Work', hasCookies: false }),
      source({ id: 'chromium:Guest', label: 'Chromium · Guest', binary: null }),
      source({ id: 'firefox:abc', kind: 'firefox', browser: 'Firefox', label: 'Firefox · Main', family: 'firefox', binary: null }),
    ])
    expect(views).toEqual([
      { id: 'chromium:Default', label: 'Chromium · Personal', available: true },
      { id: 'chromium:Profile 1', label: 'Chromium · Work', available: false },
      { id: 'chromium:Guest', label: 'Chromium · Guest', available: false },
      { id: 'firefox:abc', label: 'Firefox · Main', available: true },
    ])
  })

  it('has no views for no sources', () => {
    expect(sourceViews([])).toEqual([])
  })
})

describe('importSectionProfile', () => {
  it('reads the profile id of a browser-import section', () => {
    expect(importSectionProfile('browser-import:k3m9x2qa')).toBe('k3m9x2qa')
    expect(importSectionProfile('browser-import:default')).toBe('default')
  })

  it('is null for any other section, and for a profile id that is not one', () => {
    for (const s of ['browser', 'devices', 'browser-import:', 'browser-import:Work Profile', 'browser-import:../x', 'browser-import:K3M9X2QA', '']) {
      expect(importSectionProfile(s)).toBeNull()
    }
  })
})
