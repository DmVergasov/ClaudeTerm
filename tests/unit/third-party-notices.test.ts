import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// the bundled Inter font (SIL Open Font License) and the Lucide icons (ISC, with Feather's MIT) ship with the app, so their
// notices must ship with it too
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('third-party notices', () => {
  it('electron-builder ships the notices file with the app', () => {
    expect(read('electron-builder.yml')).toMatch(/- from: THIRD-PARTY-NOTICES\.md\r?\n\s*to: THIRD-PARTY-NOTICES\.md/)
  })

  it('the notices name Inter under the SIL Open Font License and Lucide under the ISC License', () => {
    const notices = read('THIRD-PARTY-NOTICES.md')
    expect(notices).toMatch(/Inter[\s\S]*SIL Open Font License, Version 1\.1/)
    expect(notices).toMatch(/Lucide[\s\S]*ISC License/)
    expect(notices).toContain('Copyright (c) 2013-2023 Cole Bemis')
  })

  it('the README links the notices from its license section', () => {
    expect(read('README.md')).toContain('(THIRD-PARTY-NOTICES.md)')
  })
})
