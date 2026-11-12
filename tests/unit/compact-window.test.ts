import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compactWindow, envWindow, sameModel } from '../../src/hook/compact-window'

const HOME = join('/home', 'me')
const PROJECT = join('/work', 'app')
const USER = join(HOME, '.claude', 'settings.json')
const SHARED = join(PROJECT, '.claude', 'settings.json')
const LOCAL = join(PROJECT, '.claude', 'settings.local.json')

/** a reader over the given files: their JSON, or null for a file that is not there */
const files = (byPath: Record<string, unknown>) => (path: string): string | null =>
  path in byPath ? (typeof byPath[path] === 'string' ? byPath[path] as string : JSON.stringify(byPath[path])) : null

const env = { HOME, USERPROFILE: HOME }

describe('compactWindow', () => {
  it('takes the top-level autoCompactWindow from the user settings', () => {
    expect(compactWindow('claude-opus-5-5', PROJECT, env, files({ [USER]: { autoCompactWindow: 512000 } }))).toBe(512000)
  })

  it('is null when nothing sets a window', () => {
    expect(compactWindow('claude-opus-5-5', PROJECT, env, files({ [USER]: { model: 'opus' } }))).toBeNull()
  })

  it('takes the model\'s own window over the top-level one in the same file, and "auto" there means the model\'s default', () => {
    const own = { autoCompactWindow: 512000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 300000 } } }
    expect(compactWindow('claude-opus-5-5', PROJECT, env, files({ [USER]: own }))).toBe(300000)
    const auto = { autoCompactWindow: 512000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 'auto' } } }
    expect(compactWindow('claude-opus-5-5', PROJECT, env, files({ [USER]: auto }))).toBeNull()
    // another model's entry does not apply
    const other = { autoCompactWindow: 512000, modelSettings: { 'claude-sonnet-5-5': { autoCompactWindow: 300000 } } }
    expect(compactWindow('claude-opus-5-5', PROJECT, env, files({ [USER]: other }))).toBe(512000)
  })

  it('takes the project\'s local file over its shared file, and both over the user\'s', () => {
    const all = { [USER]: { autoCompactWindow: 512000 }, [SHARED]: { autoCompactWindow: 400000 }, [LOCAL]: { autoCompactWindow: 250000 } }
    expect(compactWindow('claude-opus-5-5', PROJECT, env, files(all))).toBe(250000)
    expect(compactWindow('claude-opus-5-5', PROJECT, env, files({ [USER]: all[USER], [SHARED]: all[SHARED] }))).toBe(400000)
    // without a project folder only the user's file counts
    expect(compactWindow('claude-opus-5-5', null, env, files(all))).toBe(512000)
  })

  it('reads the user settings from CLAUDE_CONFIG_DIR when it is set', () => {
    const config = join('/elsewhere', 'claude')
    const read = files({ [join(config, 'settings.json')]: { autoCompactWindow: 600000 }, [USER]: { autoCompactWindow: 512000 } })
    expect(compactWindow('claude-opus-5-5', PROJECT, { ...env, CLAUDE_CONFIG_DIR: config }, read)).toBe(600000)
  })

  it('takes CLAUDE_CODE_AUTO_COMPACT_WINDOW over every file', () => {
    const read = files({ [LOCAL]: { autoCompactWindow: 250000 } })
    expect(compactWindow('claude-opus-5-5', PROJECT, { ...env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700k' }, read)).toBe(700000)
  })

  it('skips a file that is not JSON, and a value that is not a window', () => {
    const read = files({ [LOCAL]: '{ "autoCompactWindow": ', [SHARED]: { autoCompactWindow: 'big' }, [USER]: { autoCompactWindow: 512000 } })
    expect(compactWindow('claude-opus-5-5', PROJECT, env, read)).toBe(512000)
  })

  it('holds a window to Claude Code\'s range of 100k to 1M', () => {
    expect(compactWindow('claude-opus-5-5', PROJECT, env, files({ [USER]: { autoCompactWindow: 20000 } }))).toBe(100000)
    expect(compactWindow('claude-opus-5-5', PROJECT, env, files({ [USER]: { autoCompactWindow: 5000000 } }))).toBe(1000000)
  })
})

describe('envWindow', () => {
  it('reads a token count, with k or M for thousands or millions', () => {
    expect(envWindow('200000')).toBe(200000)
    expect(envWindow('512k')).toBe(512000)
    expect(envWindow('1M')).toBe(1000000)
  })

  it('treats a count under 100k as 100k and over 1M as 1M, as Claude Code does', () => {
    expect(envWindow('200')).toBe(100000)
    expect(envWindow('3M')).toBe(1000000)
  })

  it('ignores a value that is not a token count', () => {
    expect(envWindow(undefined)).toBeNull()
    expect(envWindow('')).toBeNull()
    expect(envWindow('auto')).toBeNull()
    expect(envWindow('lots')).toBeNull()
  })
})

describe('sameModel', () => {
  it('matches the canonical name with its 1M, dated, Bedrock and Vertex spellings', () => {
    expect(sameModel('claude-opus-5-5', 'claude-opus-5-5')).toBe(true)
    expect(sameModel('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(true)
    expect(sameModel('claude-opus-5-5-20261101', 'claude-opus-5-5')).toBe(true)
    expect(sameModel('us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5')).toBe(true)
    expect(sameModel('claude-opus-5-5@20261101', 'claude-opus-5-5')).toBe(true)
  })

  it('does not take one model for another whose name starts the same', () => {
    expect(sameModel('claude-opus-5-5', 'claude-opus-5')).toBe(false)
    expect(sameModel('claude-opus-5', 'claude-opus-5-5')).toBe(false)
    expect(sameModel('claude-sonnet-5-5', 'claude-opus-5-5')).toBe(false)
  })
})
