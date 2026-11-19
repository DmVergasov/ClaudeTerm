import { describe, expect, it } from 'vitest'
import { withFooter } from '../../src/main/browser/result-text'
import type { PageFooter } from '../../src/main/browser/result-text'

const page: PageFooter = {
  url: 'http://localhost:3000/login',
  title: 'Sign in',
  newErrors: [],
  downloads: [],
  dialogs: [],
}

describe('withFooter', () => {
  it('prints only the URL and the title when nothing else happened', () => {
    expect(withFooter('Clicked.', page)).toBe('Clicked.\n\n### Page\n- URL: http://localhost:3000/login\n- Title: Sign in')
  })

  it('prints the count of new console errors and only the first five', () => {
    const errors = ['Error 1', 'Error 2', 'Error 3', 'Error 4', 'Error 5', 'Error 6', 'Error 7']
    const text = withFooter('Done.', { ...page, newErrors: errors })
    expect(text).toBe([
      'Done.',
      '',
      '### Page',
      '- URL: http://localhost:3000/login',
      '- Title: Sign in',
      '- New console errors (7):',
      '  - Error 1',
      '  - Error 2',
      '  - Error 3',
      '  - Error 4',
      '  - Error 5',
    ].join('\n'))
  })

  it('cuts each console error to 300 code points with an ellipsis', () => {
    const text = withFooter('Done.', { ...page, newErrors: ['e'.repeat(310)] })
    expect(text.split('\n').slice(5)).toEqual([
      '- New console errors (1):',
      `  - ${'e'.repeat(299)}…`,
    ])
  })

  it('prints the downloads and each dialog with the answer it got', () => {
    const text = withFooter('Saved.', {
      ...page,
      downloads: ['C:\\Users\\Ada\\Downloads\\report.csv', 'C:\\Users\\Ada\\Downloads\\notes.txt'],
      dialogs: [
        { type: 'confirm', message: 'Delete this item?', answer: 'Cancel' },
        { type: 'alert', message: 'Saved', answer: 'closed' },
      ],
    })
    expect(text.split('\n').slice(5)).toEqual([
      '- Downloaded: C:\\Users\\Ada\\Downloads\\report.csv, C:\\Users\\Ada\\Downloads\\notes.txt',
      '- Dialog: confirm "Delete this item?" → Cancel',
      '- Dialog: alert "Saved" → closed',
    ])
  })

  it('cuts a dialog message to 300 code points', () => {
    const text = withFooter('Done.', { ...page, dialogs: [{ type: 'prompt', message: 'p'.repeat(310), answer: 'Cancel' }] })
    expect(text.split('\n').slice(5)).toEqual([`- Dialog: prompt "${'p'.repeat(299)}…" → Cancel`])
  })

  it('prints five dialogs and then how many more there are', () => {
    const dialogs = Array.from({ length: 7 }, (_, i) => ({ type: 'alert', message: `m${i + 1}`, answer: 'closed' }))
    const text = withFooter('Done.', { ...page, dialogs })
    expect(text.split('\n').slice(5)).toEqual([
      '- Dialog: alert "m1" → closed',
      '- Dialog: alert "m2" → closed',
      '- Dialog: alert "m3" → closed',
      '- Dialog: alert "m4" → closed',
      '- Dialog: alert "m5" → closed',
      '- …and 2 more dialogs',
    ])
  })
})
