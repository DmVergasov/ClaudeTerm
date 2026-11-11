import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOOK_MARKER, migrateLook } from '../../src/main/look-migration'

// the rename fails the way Windows fails it when an editor holds settings.json open without delete sharing
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
  }
})

let dir = ''
const settingsPath = (): string => join(dir, 'settings.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ct-look-locked-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('migrateLook when settings.json is locked', () => {
  it('a rename that fails leaves no temporary file, the settings as they were, and no marker, so the next start retries', () => {
    const original = '{\n  "theme": "Campbell"\n}\n'
    writeFileSync(settingsPath(), original)
    const errors: string[] = []
    migrateLook(dir, (message) => errors.push(message))
    expect(errors).toHaveLength(1)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(readFileSync(settingsPath(), 'utf8')).toBe(original)
    expect(existsSync(join(dir, LOOK_MARKER))).toBe(false)
  })
})
