import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../../src/main/log'

describe('createLogger', () => {
  it('appends timestamped lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-log-'))
    createLogger(dir).warn('careful')
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T.* WARN careful\n$/)
  })

  it('rotates main.log above 1 MB and keeps five files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-log-'))
    const log = createLogger(dir)
    writeFileSync(join(dir, 'main.log'), 'x'.repeat(1024 * 1024 + 1))
    for (let i = 1; i <= 4; i++) writeFileSync(join(dir, `main.${i}.log`), `old${i}`)
    log.info('hello')
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toMatch(/INFO hello\n$/)
    expect(readFileSync(join(dir, 'main.1.log'), 'utf8').length).toBe(1024 * 1024 + 1)
    expect(readFileSync(join(dir, 'main.2.log'), 'utf8')).toBe('old1')
    expect(readFileSync(join(dir, 'main.4.log'), 'utf8')).toBe('old3')
    expect(existsSync(join(dir, 'main.5.log'))).toBe(false)
  })
})
