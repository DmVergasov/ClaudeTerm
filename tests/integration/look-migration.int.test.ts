import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOOK_MARKER, migrateLook } from '../../src/main/look-migration'

let dir = ''
const settingsPath = (): string => join(dir, 'settings.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ct-look-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('migrateLook', () => {
  it('the switch happens once: a user who picks Campbell again keeps it', () => {
    writeFileSync(settingsPath(), '{\n  "theme": "Campbell"\n}\n')
    migrateLook(dir)
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8')).theme).toBe('Graphite')
    expect(existsSync(join(dir, LOOK_MARKER))).toBe(true)

    writeFileSync(settingsPath(), '{\n  "theme": "Campbell"\n}\n')
    migrateLook(dir)
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8')).theme).toBe('Campbell')
  })

  it('a fresh install gets the marker, so a later Campbell is kept', () => {
    migrateLook(dir)
    expect(existsSync(settingsPath())).toBe(false)
    expect(existsSync(join(dir, LOOK_MARKER))).toBe(true)
  })

  it('a broken settings.json is left as it is', () => {
    writeFileSync(settingsPath(), '{ not json')
    migrateLook(dir)
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{ not json')
    expect(existsSync(join(dir, LOOK_MARKER))).toBe(true)
  })

  it('keeps CRLF line endings of the file it changes', () => {
    writeFileSync(settingsPath(), '{\r\n  "font": { "size": 12 },\r\n  "theme": "Campbell"\r\n}\r\n')
    migrateLook(dir)
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{\r\n  "font": {\r\n    "size": 12\r\n  },\r\n  "theme": "Graphite"\r\n}\r\n')
  })
  it('the switch writes through a temporary file and leaves none behind, even one a crash left', () => {
    writeFileSync(settingsPath(), '{\n  "theme": "Campbell"\n}\n')
    writeFileSync(join(dir, 'settings.json.tmp'), 'cut off by a crash')
    migrateLook(dir)
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{\n  "theme": "Graphite"\n}\n')
  })
})
