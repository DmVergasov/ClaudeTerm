import { describe, expect, it } from 'vitest'
import { isNoteSize, isProjectKey, noteProjectOf } from '../../src/shared/note'
import type { TabPlace } from '../../src/shared/types'

const place: TabPlace = {
  project: { key: 'c:\\work\\acme', name: 'acme', parent: 'work' },
  worktree: null,
  branch: 'main',
}

describe('note model', () => {
  it('isNoteSize takes integer sizes within the bounds', () => {
    expect(isNoteSize({ width: 340, height: 240 })).toBe(true)
    expect(isNoteSize({ width: 260, height: 140 })).toBe(true)
    expect(isNoteSize({ width: 4000, height: 4000 })).toBe(true)
    expect(isNoteSize({ width: 259, height: 240 })).toBe(false)
    expect(isNoteSize({ width: 340, height: 139 })).toBe(false)
    expect(isNoteSize({ width: 4001, height: 240 })).toBe(false)
    expect(isNoteSize({ width: 340.5, height: 240 })).toBe(false)
    expect(isNoteSize(null)).toBe(false)
    expect(isNoteSize([340, 240])).toBe(false)
    expect(isNoteSize({ width: '340', height: 240 })).toBe(false)
  })

  it('isProjectKey takes 1 to 4096 characters without NUL', () => {
    expect(isProjectKey('c:\\work\\acme')).toBe(true)
    expect(isProjectKey('/home/u/acme')).toBe(true)
    expect(isProjectKey('')).toBe(false)
    expect(isProjectKey('x'.repeat(4097))).toBe(false)
    expect(isProjectKey('a\0b')).toBe(false)
    expect(isProjectKey(5)).toBe(false)
  })

  it('noteProjectOf: remote, not known yet, outside git, a project', () => {
    expect(noteProjectOf(true, place)).toEqual({ key: null, why: 'remote' })
    expect(noteProjectOf(false, undefined)).toEqual({ key: null, why: 'unknown' })
    expect(noteProjectOf(false, null)).toEqual({ key: null, why: 'outside' })
    expect(noteProjectOf(false, place)).toEqual({ key: 'c:\\work\\acme', name: 'acme' })
  })
})
