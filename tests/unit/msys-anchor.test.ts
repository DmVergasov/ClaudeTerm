import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { anchorExe, findGitBash, MsysAnchor, type AnchorChild } from '../../src/main/msys-anchor'

const has = (...files: string[]) => (p: string): boolean => files.includes(p)

describe('findGitBash', () => {
  const USUAL = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const USUAL_X86 = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'

  it('takes CLAUDE_CODE_GIT_BASH_PATH first when it names a bash or sh that exists', () => {
    const custom = 'D:\\Tools\\Git\\bin\\bash.exe'
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: custom }, has(custom, USUAL))).toBe(custom)
    const sh = 'D:\\msys64\\usr\\bin\\SH.EXE'
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: sh }, has(sh, USUAL))).toBe(sh)
  })

  it('like Claude Code, looks further when CLAUDE_CODE_GIT_BASH_PATH is missing or not a bash', () => {
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Gone\\bin\\bash.exe' }, has(USUAL))).toBe(USUAL)
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Tools\\Git\\cmd\\git.exe' }, has('D:\\Tools\\Git\\cmd\\git.exe', USUAL))).toBe(USUAL)
  })

  it("then Git's usual install folders", () => {
    expect(findGitBash({}, has(USUAL, USUAL_X86))).toBe(USUAL)
    expect(findGitBash({}, has(USUAL_X86))).toBe(USUAL_X86)
  })

  it('then bin\\bash.exe of the first git.exe on PATH', () => {
    const env = { PATH: 'C:\\Windows\\system32;D:\\Apps\\Git\\cmd;E:\\Other\\Git\\cmd' }
    const exists = has('D:\\Apps\\Git\\cmd\\git.exe', 'D:\\Apps\\Git\\bin\\bash.exe', 'E:\\Other\\Git\\cmd\\git.exe', 'E:\\Other\\Git\\bin\\bash.exe')
    expect(findGitBash(env, exists)).toBe('D:\\Apps\\Git\\bin\\bash.exe')
  })

  it('only the first git on PATH counts, and a relative folder in PATH is skipped', () => {
    const exists = has('D:\\Scoop\\shims\\git.exe', 'E:\\Git\\cmd\\git.exe', 'E:\\Git\\bin\\bash.exe', 'tools\\git.exe', 'bin\\bash.exe')
    expect(findGitBash({ PATH: 'D:\\Scoop\\shims;E:\\Git\\cmd' }, exists)).toBeNull()
    expect(findGitBash({ PATH: 'tools;;E:\\Git\\cmd' }, exists)).toBe('E:\\Git\\bin\\bash.exe')
  })

  it('no Git Bash: null', () => {
    expect(findGitBash({ PATH: 'C:\\Windows\\system32' }, () => false)).toBeNull()
    expect(findGitBash({}, () => false)).toBeNull()
  })
})

describe('anchorExe', () => {
  it("is the same Git's own sleep.exe: in usr\\bin under Git's bin\\bash.exe, or next to a usr\\bin\\bash.exe", () => {
    const sleep = 'C:\\Program Files\\Git\\usr\\bin\\sleep.exe'
    expect(anchorExe('C:\\Program Files\\Git\\bin\\bash.exe', has(sleep))).toBe(sleep)
    expect(anchorExe('C:\\Program Files\\Git\\usr\\bin\\bash.exe', has(sleep))).toBe(sleep)
    expect(anchorExe('D:\\msys64\\usr\\bin\\sh.exe', has('D:\\msys64\\usr\\bin\\sleep.exe'))).toBe('D:\\msys64\\usr\\bin\\sleep.exe')
  })

  it('null without a sleep.exe', () => {
    expect(anchorExe('C:\\Program Files\\Git\\bin\\bash.exe', () => false)).toBeNull()
  })
})

class FakeChild extends EventEmitter implements AnchorChild {
  readonly stderr = new EventEmitter()
  killed = false
  constructor(readonly pid: number) {
    super()
  }

  kill(): boolean {
    this.killed = true
    return true
  }
}

const FILE = 'C:\\Program Files\\Git\\usr\\bin\\sleep.exe'
const STUCK = '      0 [main] sleep (4242) C:\\Program Files\\Git\\usr\\bin\\sleep.exe: *** fatal error - add_item ("\\??\\C:\\Program Files\\Git", "/", ...) failed, errno 1\nStack trace:\n'

function setup(o: { spawnThrows?: boolean } = {}) {
  const children: FakeChild[] = []
  const logs: string[] = []
  const anchor = new MsysAnchor(FILE, {
    spawn: (file) => {
      if (o.spawnThrows) throw new Error('spawn EPERM')
      expect(file).toBe(FILE)
      const child = new FakeChild(100 + children.length)
      children.push(child)
      return child
    },
    log: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`) }
  })
  return { anchor, children, logs }
}

describe('MsysAnchor', () => {
  it('starts one anchor however many Claude launches ask for it', () => {
    const { anchor, children, logs } = setup()
    anchor.ensure()
    children[0].emit('spawn')
    anchor.ensure()
    anchor.ensure()
    expect(children).toHaveLength(1)
    expect(logs).toEqual([`info:MSYS anchor started: ${FILE} (pid 100)`])
  })

  it('an anchor that ended is logged with what it wrote, and the next Claude launch starts another', () => {
    const { anchor, children, logs } = setup()
    anchor.ensure()
    children[0].stderr.emit('data', Buffer.from(STUCK))
    children[0].emit('exit', 1, null)
    children[0].emit('close', 1, null)
    expect(logs).toEqual([
      'warn:MSYS anchor ended (exit code 1): 0 [main] sleep (4242) C:\\Program Files\\Git\\usr\\bin\\sleep.exe: *** fatal error - add_item ("\\??\\C:\\Program Files\\Git", "/", ...) failed, errno 1 Stack trace:'
    ])
    anchor.ensure()
    expect(children).toHaveLength(2)
  })

  it('one that cannot start is logged once; the next Claude launch tries again', () => {
    const { anchor, children, logs } = setup()
    anchor.ensure()
    children[0].emit('error', new Error('spawn ENOENT'))
    children[0].emit('close', -4058, null)
    expect(logs).toEqual(['warn:MSYS anchor failed: spawn ENOENT'])
    anchor.ensure()
    expect(children).toHaveLength(2)
    const thrown = setup({ spawnThrows: true })
    thrown.anchor.ensure()
    thrown.anchor.ensure()
    expect(thrown.logs).toEqual([`warn:cannot start the MSYS anchor ${FILE}: spawn EPERM`, `warn:cannot start the MSYS anchor ${FILE}: spawn EPERM`])
  })

  it('the late end of an anchor that was replaced leaves the new one alone', () => {
    const { anchor, children } = setup()
    anchor.ensure()
    children[0].emit('error', new Error('spawn EBUSY'))
    anchor.ensure()
    children[0].emit('close', 1, null)
    anchor.ensure()
    expect(children).toHaveLength(2)
  })

  it('stop ends it for good: its end is not logged as a problem, and nothing starts it again', () => {
    const { anchor, children, logs } = setup()
    anchor.ensure()
    anchor.stop()
    expect(children[0].killed).toBe(true)
    children[0].emit('close', null, 'SIGTERM')
    anchor.ensure()
    expect(children).toHaveLength(1)
    expect(logs.filter((l) => l.startsWith('warn:'))).toEqual([])
  })
})
