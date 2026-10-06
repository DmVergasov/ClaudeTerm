import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSocket } from '../../src/main/socket-file'
import { WIN } from '../fixtures/platform'

const uid = process.getuid?.() ?? -1
const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

function listen(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    servers.push(s)
    s.once('error', reject)
    s.listen(path, () => resolve(s))
  })
}

const newDir = (): string => mkdtempSync(join(tmpdir(), 'ct-sock-'))

describe.runIf(!WIN)('prepareSocket', () => {
  it('creates the private folder, open to this user only', () => {
    const dir = join(newDir(), 'claudeterm-1')
    prepareSocket(join(dir, 'x.sock'), { privateDir: dir, uid })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('refuses a private folder others can enter', () => {
    const dir = newDir()
    chmodSync(dir, 0o755)
    expect(() => prepareSocket(join(dir, 'x.sock'), { privateDir: dir, uid })).toThrow('must be a folder only you can access')
  })

  it('refuses a private folder that belongs to someone else', () => {
    const dir = newDir()
    chmodSync(dir, 0o700)
    expect(() => prepareSocket(join(dir, 'x.sock'), { privateDir: dir, uid: uid + 1 })).toThrow('must be a folder only you can access')
  })

  it('a socket left behind is replaced', async () => {
    const path = join(newDir(), 'x.sock')
    await listen(path) // stands for the socket of a run that crashed
    prepareSocket(path, { privateDir: '/nowhere', uid })
    await expect(listen(path)).resolves.toBeDefined()
  })

  it('never removes something that is not a socket', () => {
    const path = join(newDir(), 'x.sock')
    writeFileSync(path, 'mine')
    expect(() => prepareSocket(path, { privateDir: '/nowhere', uid })).toThrow('is not a socket')
  })
})
