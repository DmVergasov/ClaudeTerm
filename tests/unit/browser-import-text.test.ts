import { describe, expect, it } from 'vitest'
import { importView } from '../../src/shared/browser-import-text'

// The import sheet's text for each status, exact as the Global Constraints give it.
describe('importView', () => {
  it('idle shows nothing and offers nothing', () => {
    expect(importView({ state: 'idle' })).toEqual({ lines: [], running: false, busy: false, cancel: false, choices: [], final: false })
  })

  it('waiting-close asks the person to close the browser, with the tray hint, and offers Cancel', () => {
    const v = importView({ state: 'waiting-close', browser: 'Chromium' })
    expect(v).toMatchObject({ running: true, busy: false, cancel: true, final: false })
    expect(v.lines).toEqual([
      'Close Chromium to continue. The import starts as soon as it is closed.',
      'If it keeps running in the background, quit it from the tray icon.',
    ])
  })

  it('setup says the remote debugging page is open, with a spinner and Cancel', () => {
    const v = importView({ state: 'setup', browser: 'Chrome' })
    expect(v).toMatchObject({ running: true, busy: true, cancel: true, final: false })
    expect(v.lines).toEqual(['Chrome opened its remote debugging page. Turn on remote debugging there; the import goes on by itself.'])
  })

  it('allow asks for the connection to be allowed, with a spinner and Cancel', () => {
    const v = importView({ state: 'allow', browser: 'Edge' })
    expect(v).toMatchObject({ running: true, busy: true, cancel: true })
    expect(v.lines).toEqual(['Allow the connection in Edge.'])
  })

  it('pick-profile lists the profiles as choices, with the hint and Cancel', () => {
    const v = importView({
      state: 'pick-profile',
      browser: 'Chrome',
      profiles: [
        { contextId: 'c1', label: '1 tab: Inbox' },
        { contextId: 'c2', label: '2 tabs: Board, Notes' },
      ],
    })
    expect(v).toMatchObject({ running: true, busy: false, cancel: true, final: false })
    expect(v.lines).toEqual(['Which Chrome profile?', 'To import another profile, open a window of it in Chrome.'])
    expect(v.choices).toEqual([
      { contextId: 'c1', label: '1 tab: Inbox' },
      { contextId: 'c2', label: '2 tabs: Board, Notes' },
    ])
  })

  it('importing has a spinner and Cancel', () => {
    expect(importView({ state: 'importing' })).toMatchObject({ running: true, busy: true, cancel: true, final: false })
  })

  it('done gives the counts and then each note on its own line', () => {
    const v = importView({
      state: 'done',
      imported: 2,
      sites: 1,
      skipped: 1,
      notes: ['Sites that keep their sign-in outside cookies need you to sign in again here.', 'Google sign-ins are not carried over: Chrome ties them to this computer.'],
    })
    expect(v).toMatchObject({ running: false, busy: false, cancel: false, final: true })
    expect(v.lines).toEqual([
      'Imported 2 cookies for 1 site.',
      'Sites that keep their sign-in outside cookies need you to sign in again here.',
      'Google sign-ins are not carried over: Chrome ties them to this computer.',
    ])
  })

  it('done uses the singular for a count of one, each number on its own', () => {
    const notes = ['Sites that keep their sign-in outside cookies need you to sign in again here.']
    expect(importView({ state: 'done', imported: 1, sites: 1, skipped: 0, notes }).lines[0]).toBe('Imported 1 cookie for 1 site.')
    expect(importView({ state: 'done', imported: 2, sites: 1, skipped: 0, notes }).lines[0]).toBe('Imported 2 cookies for 1 site.')
    expect(importView({ state: 'done', imported: 1, sites: 2, skipped: 0, notes }).lines[0]).toBe('Imported 1 cookie for 2 sites.')
    expect(importView({ state: 'done', imported: 0, sites: 0, skipped: 0, notes }).lines[0]).toBe('Imported 0 cookies for 0 sites.')
  })

  it('failed shows the error', () => {
    expect(importView({ state: 'failed', error: 'Could not read Firefox cookies from "abc" (EBUSY).' })).toMatchObject({
      final: true,
      lines: ['Could not read Firefox cookies from "abc" (EBUSY).'],
    })
  })

  it('cancelled says so, and how many were already imported when some were', () => {
    expect(importView({ state: 'cancelled' })).toMatchObject({ final: true, lines: ['Cancelled.'] })
    expect(importView({ state: 'cancelled', imported: 0 })).toMatchObject({ lines: ['Cancelled.'] })
    expect(importView({ state: 'cancelled', imported: 3 })).toMatchObject({ final: true, lines: ['Cancelled. 3 cookies were already imported.'] })
    expect(importView({ state: 'cancelled', imported: 1 })).toMatchObject({ final: true, lines: ['Cancelled. 1 cookie was already imported.'] })
  })
})
