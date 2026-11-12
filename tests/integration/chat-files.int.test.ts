import { closeSync, mkdirSync, mkdtempSync, openSync, ftruncateSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalFolder, readTrustFile } from '../../src/main/chat/chat-files'
import { pathKey } from '../../src/main/path-key'

const dir = (): string => mkdtempSync(join(tmpdir(), 'ct-chat-files-'))
const MIB = 1024 * 1024

describe('readTrustFile', () => {
  it('a .claude.json over 16 MiB is refused before it is read', async () => {
    const file = join(dir(), '.claude.json')
    // sparse: the size is set without writing the bytes
    const fd = openSync(file, 'w')
    ftruncateSync(fd, 16 * MIB + 1)
    closeSync(fd)
    expect(await readTrustFile(file)).toBeNull()
  })

  it('a missing file is null', async () => {
    expect(await readTrustFile(join(dir(), 'missing.json'))).toBeNull()
  })

  it('a small file is read as its text', async () => {
    const file = join(dir(), '.claude.json')
    writeFileSync(file, '{"projects":{}}')
    expect(await readTrustFile(file)).toBe('{"projects":{}}')
  })
})

describe('canonicalFolder', () => {
  it('a link to a folder resolves to the folder real path', async () => {
    const root = dir()
    const target = join(root, 'real folder')
    mkdirSync(target)
    const link = join(root, 'link')
    // a junction on Windows needs no privilege; a directory symlink elsewhere
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(pathKey(await canonicalFolder(link))).toBe(pathKey(realpathSync.native(target)))
  })

  it('a missing folder comes back as given', async () => {
    const missing = join(dir(), 'not-there')
    expect(await canonicalFolder(missing)).toBe(missing)
  })
})
