import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')

describe('packaging config', () => {
  it('turns on cookie encryption for packaged builds', () => {
    // the file is CRLF in the working copy on Windows: the regex reads LF line ends
    const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')
    expect(builder).toMatch(/^electronFuses:\s*\n(?:[ \t]+.*\n)*?[ \t]+enableCookieEncryption:\s*true\s*$/m)
  })
})
