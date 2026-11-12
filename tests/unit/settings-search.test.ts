import { describe, expect, it } from 'vitest'
import { countLabel, matchesQuery, matchRanges, queryWords } from '../../src/renderer/settings-search'

describe('settings search', () => {
  it('queryWords: lower case, split on white space, nothing for a blank query', () => {
    expect(queryWords('  Refresh   EVERY ')).toEqual(['refresh', 'every'])
    expect(queryWords('   ')).toEqual([])
  })

  it('matchesQuery: every word somewhere in the text, case ignored', () => {
    expect(matchesQuery('Refresh every 1–300 seconds claude.statusRefreshInterval', ['refresh', 'every'])).toBe(true)
    expect(matchesQuery('Refresh on a timer', ['refresh', 'every'])).toBe(false)
    expect(matchesQuery('Scrollback lines', ['scroll'])).toBe(true)
    expect(matchesQuery('anything', [])).toBe(true)
  })

  it('matchRanges: where the words are, as [start, end) in order, overlapping or touching ones merged', () => {
    expect(matchRanges('Shell for Claude tabs', ['shell'])).toEqual([[0, 5]])
    expect(matchRanges("What the tab's shell runs to start Claude", ['shell', 'claude'])).toEqual([[15, 20], [35, 41]])
    expect(matchRanges('aaaa', ['aa'])).toEqual([[0, 4]])
    expect(matchRanges('Refresh every', ['fresh', 'refresh'])).toEqual([[0, 7]])
    expect(matchRanges('No match here', ['zzz'])).toEqual([])
  })

  it('countLabel: none, one, many', () => {
    expect(countLabel(0)).toBe('No settings')
    expect(countLabel(1)).toBe('1 setting')
    expect(countLabel(4)).toBe('4 settings')
  })
})
