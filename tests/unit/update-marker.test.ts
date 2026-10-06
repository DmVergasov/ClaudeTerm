import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { consumeUpdateMarker, MARKER_MAX_AGE_MS, UPDATE_MARKER, writeUpdateMarker } from '../../src/main/update-marker'

const dir = () => mkdtempSync(join(tmpdir(), 'ct-marker-'))

describe('update marker', () => {
  it('a fresh marker restores once and is deleted', () => {
    const d = dir()
    expect(writeUpdateMarker(d, 1000)).toBe(true)
    expect(consumeUpdateMarker(d, 1000 + 60_000)).toBe(true)
    expect(existsSync(join(d, UPDATE_MARKER))).toBe(false)
    expect(consumeUpdateMarker(d, 1000 + 60_000)).toBe(false)
  })

  it('a stale marker is ignored and deleted', () => {
    const d = dir()
    writeUpdateMarker(d, 1000)
    expect(consumeUpdateMarker(d, 1000 + MARKER_MAX_AGE_MS + 1)).toBe(false)
    expect(existsSync(join(d, UPDATE_MARKER))).toBe(false)
  })

  it('no marker, a broken one, or one from the future means no restore', () => {
    const d = dir()
    expect(consumeUpdateMarker(d, 1000)).toBe(false)
    writeFileSync(join(d, UPDATE_MARKER), '{not json')
    expect(consumeUpdateMarker(d, 1000)).toBe(false)
    expect(existsSync(join(d, UPDATE_MARKER))).toBe(false)
    writeUpdateMarker(d, 1000 + 60 * 60_000)
    expect(consumeUpdateMarker(d, 1000)).toBe(false)
  })

  it('a marker a moment ahead of now still restores: the clock can be stepped back between quit and restart', () => {
    const d = dir()
    writeUpdateMarker(d, 10_000)
    expect(consumeUpdateMarker(d, 10_000 - 700)).toBe(true)
  })

  it('writing into a missing folder fails softly', () => {
    expect(writeUpdateMarker(join(dir(), 'missing', 'deeper'), 1000)).toBe(false)
  })
})
