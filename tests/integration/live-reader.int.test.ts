import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectCdp, type CdpSocket } from '../../src/main/browser-import/cdp-socket'
import { profileLabel, readLiveCookies, type LiveReadDeps } from '../../src/main/browser-import/live-reader'
import { inspectUrl, type ImportSource } from '../../src/main/browser-import/sources'

// Every browser here is the stand-in (tests/fixtures/stand-in-devtools.mjs) run from a temp folder of this test; the
// cookies, titles and URLs are invented. No real browser folder or DevToolsActivePort is read.

const STAND_IN = resolve(import.meta.dirname, '..', 'fixtures', 'stand-in-devtools.mjs')
const FUTURE_S = Math.floor(Date.now() / 1000) + 30 * 86400
const PAST_S = Math.floor(Date.now() / 1000) - 86400
// the only methods the reader may send
const ALLOWED = new Set(['Target.getTargets', 'Target.attachToTarget', 'Network.getAllCookies', 'Target.detachFromTarget'])

let root: string
let udd: string
let children: ChildProcess[]
let controller: AbortController

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ct-live-'))
  udd = join(root, 'Chrome', 'User Data')
  mkdirSync(udd, { recursive: true })
  children = []
  controller = new AbortController()
})

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r))
      child.kill()
      await exited
    }
  }
  rmSync(root, { recursive: true, force: true })
})

function startStandIn(env: Record<string, string> = {}, extraArgs: string[] = []): ChildProcess {
  const child = spawn(process.execPath, [STAND_IN, `--user-data-dir=${udd}`, ...extraArgs], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  children.push(child)
  return child
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor: condition not met')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function writeContexts(contexts: unknown[]): void {
  writeFileSync(join(udd, 'stand-in-contexts.json'), JSON.stringify(contexts))
}

function methodsSent(): string[] {
  const log = join(udd, 'stand-in-methods.log')
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l !== '') : []
}

function liveSource(): ImportSource {
  return {
    id: 'chrome:open',
    kind: 'chrome',
    browser: 'Chrome',
    label: 'Chrome · open profiles',
    family: 'chromium',
    userDataDir: udd,
    profileDir: udd,
    profileName: '',
    email: null,
    hasCookies: true,
    binary: null,
    mode: 'live',
  }
}

function cookie(name: string, expires: number) {
  return { name, value: `invented-${name}`, domain: '.example.com', path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' }
}

function makeDeps(over: Partial<LiveReadDeps> = {}): LiveReadDeps {
  return {
    readFile: (p) => readFile(p, 'utf8'),
    connect: connectCdp,
    openSetupPage: vi.fn(),
    onStatus: vi.fn(),
    pickProfile: vi.fn(async () => {
      throw new Error('pickProfile was not expected')
    }),
    signal: controller.signal,
    retryMs: 50,
    setupTimeoutMs: 5000,
    ...over,
  }
}

describe('profileLabel', () => {
  it('names the first three distinct web pages, cut titles to 30 characters, and counts all pages', () => {
    const pages = [
      { title: 'GitHub', url: 'https://github.example.com/' },
      { title: 'Gmail', url: 'https://mail.example.com/' },
      { title: 'Jira', url: 'https://jira.example.com/board' },
      { title: 'Chrome settings', url: 'chrome://settings/' },
      { title: 'GitHub', url: 'https://github.example.com/repo' },
      ...Array.from({ length: 7 }, (_, i) => ({ title: `Page ${i}`, url: `https://example.com/${i}` })),
    ]
    expect(pages).toHaveLength(12)
    expect(profileLabel(pages)).toBe('12 tabs: GitHub, Gmail, Jira')
  })

  it('names a title once when it repeats among the first three web pages', () => {
    expect(
      profileLabel([
        { title: 'GitHub', url: 'https://github.example.com/' },
        { title: 'GitHub', url: 'https://github.example.com/repo' },
        { title: 'Gmail', url: 'https://mail.example.com/' },
        { title: 'Jira', url: 'https://jira.example.com/board' },
        { title: 'Docs', url: 'https://docs.example.com/' },
      ]),
    ).toBe('5 tabs: GitHub, Gmail, Jira')
  })

  it('cuts a 40-character title to 30 characters with an ellipsis', () => {
    const title = 'A'.repeat(40)
    const label = profileLabel([{ title, url: 'https://example.com/' }])
    expect(label).toBe(`1 tab: ${'A'.repeat(29)}…`)
  })

  it('does not name chrome:// pages, and says how many tabs without any web page', () => {
    expect(profileLabel([{ title: 'Settings', url: 'chrome://settings/' }])).toBe('1 tab')
    expect(
      profileLabel([
        { title: 'Settings', url: 'chrome://settings/' },
        { title: 'Extensions', url: 'chrome://extensions/' },
        { title: '', url: 'about:blank' },
      ]),
    ).toBe('3 tabs')
  })
})

describe('readLiveCookies against the stand-in', () => {
  it('reads the only open profile: the expired cookie is skipped, and only the reader methods are sent', async () => {
    writeContexts([
      {
        contextId: 'ctx-main',
        pages: [
          { targetId: 'page-1', title: 'Mail', url: 'https://mail.example.com/' },
          { targetId: 'page-2', title: 'Notes', url: 'https://notes.example.com/' },
        ],
        cookies: [cookie('session', FUTURE_S), cookie('stale', PAST_S)],
      },
    ])
    startStandIn()
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))

    const result = await readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps())

    expect(result.skipped).toBe(1)
    expect(result.cookies.map((c) => c.name)).toEqual(['session'])
    expect(result.cookies[0]).toMatchObject({ domain: '.example.com', hostOnly: false, secure: true, httpOnly: true, sameSite: 'lax' })
    const sent = methodsSent()
    expect(sent).toEqual(expect.arrayContaining(['Target.attachToTarget', 'Network.getAllCookies', 'Target.detachFromTarget']))
    expect(sent.every((m) => ALLOWED.has(m))).toBe(true)
    expect(sent).not.toContain('Browser.close')
  })

  it('asks which profile when several are open, and reads the chosen one', async () => {
    writeContexts([
      { contextId: 'ctx-a', pages: [{ targetId: 'page-a', title: 'Mail', url: 'https://mail.example.com/' }], cookies: [cookie('first', FUTURE_S)] },
      {
        contextId: 'ctx-b',
        pages: [
          { targetId: 'page-b1', title: 'Docs', url: 'https://docs.example.com/' },
          { targetId: 'page-b2', title: 'Notes', url: 'https://notes.example.com/' },
        ],
        cookies: [cookie('second', FUTURE_S)],
      },
    ])
    startStandIn()
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const pickProfile = vi.fn(async (profiles: { contextId: string; label: string }[]) => profiles[1].contextId)

    const result = await readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps({ pickProfile }))

    expect(pickProfile).toHaveBeenCalledTimes(1)
    expect(pickProfile.mock.calls[0][0]).toEqual([
      { contextId: 'ctx-a', label: '1 tab: Mail' },
      { contextId: 'ctx-b', label: '2 tabs: Docs, Notes' },
    ])
    expect(result.cookies.map((c) => c.name)).toEqual(['second'])
  })

  it('opens the setup page once when remote debugging is off, and reads once the browser has it on', async () => {
    // the setup page is opened by a browser that turns remote debugging on: the stand-in with the setup URL does that
    const openSetupPage = vi.fn(() => {
      startStandIn({}, [inspectUrl('chrome')])
    })
    writeContexts([{ contextId: 'ctx-main', pages: [{ targetId: 'page-1', title: 'Mail', url: 'https://mail.example.com/' }], cookies: [cookie('session', FUTURE_S)] }])
    const onStatus = vi.fn()

    const result = await readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps({ openSetupPage, onStatus }))

    expect(openSetupPage).toHaveBeenCalledTimes(1)
    expect(onStatus.mock.calls).toEqual([[{ state: 'setup' }]])
    expect(result.cookies.map((c) => c.name)).toEqual(['session'])
    expect(readFileSync(join(udd, 'stand-in-opened.log'), 'utf8')).toBe('chrome://inspect/#remote-debugging\n')
  })

  it('reports the Allow prompt while the browser has not answered, then reads', async () => {
    writeContexts([{ contextId: 'ctx-main', pages: [{ targetId: 'page-1', title: 'Mail', url: 'https://mail.example.com/' }], cookies: [cookie('session', FUTURE_S)] }])
    startStandIn({ STAND_IN_ALLOW_MS: '1500' })
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const onStatus = vi.fn()
    const openSetupPage = vi.fn()

    const result = await readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps({ onStatus, openSetupPage }))

    expect(onStatus.mock.calls).toEqual([[{ state: 'allow' }]])
    expect(openSetupPage).not.toHaveBeenCalled()
    expect(result.cookies.map((c) => c.name)).toEqual(['session'])
  })

  it('a cancel while the profile is being picked rejects with cancelled', async () => {
    writeContexts([
      { contextId: 'ctx-a', pages: [{ targetId: 'page-a', title: 'Mail', url: 'https://mail.example.com/' }], cookies: [] },
      { contextId: 'ctx-b', pages: [{ targetId: 'page-b', title: 'Docs', url: 'https://docs.example.com/' }], cookies: [] },
    ])
    startStandIn()
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const pickProfile = vi.fn(() => new Promise<string>(() => {}))
    const read = readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps({ pickProfile }))
    await waitFor(() => pickProfile.mock.calls.length === 1)

    controller.abort()

    await expect(read).rejects.toThrow('cancelled')
  })

  it('a cancel while Network.getAllCookies is pending rejects with cancelled', async () => {
    writeContexts([{ contextId: 'ctx-main', pages: [{ targetId: 'page-1', title: 'Mail', url: 'https://mail.example.com/' }], cookies: [cookie('session', FUTURE_S)] }])
    startStandIn({ STAND_IN_SILENT: 'Network.getAllCookies' })
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const read = readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps())
    await waitFor(() => methodsSent().includes('Network.getAllCookies'))

    controller.abort()

    await expect(read).rejects.toThrow('cancelled')
  })

  it('a cancel during the read of DevToolsActivePort never opens the setup page', async () => {
    const openSetupPage = vi.fn()
    const readFileThenCancel = async (): Promise<string> => {
      controller.abort()
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    }

    await expect(readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps({ readFile: readFileThenCancel, openSetupPage }))).rejects.toThrow(
      'cancelled',
    )
    expect(openSetupPage).not.toHaveBeenCalled()
  })

  it('an Allow that the person refuses is final: no retry and no setup page', async () => {
    writeContexts([{ contextId: 'ctx-main', pages: [{ targetId: 'page-1', title: 'Mail', url: 'https://mail.example.com/' }], cookies: [cookie('session', FUTURE_S)] }])
    startStandIn({ STAND_IN_ALLOW_MS: '1500', STAND_IN_DENY: '1' })
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const onStatus = vi.fn()
    const openSetupPage = vi.fn()

    await expect(readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps({ onStatus, openSetupPage }))).rejects.toThrow(
      'The connection was not allowed in Chrome.',
    )
    expect(onStatus.mock.calls).toEqual([[{ state: 'allow' }]])
    expect(openSetupPage).not.toHaveBeenCalled()
  })

  it('a read whose Target.detachFromTarget gets no answer still completes within about 2 s', async () => {
    writeContexts([{ contextId: 'ctx-main', pages: [{ targetId: 'page-1', title: 'Mail', url: 'https://mail.example.com/' }], cookies: [cookie('session', FUTURE_S)] }])
    startStandIn({ STAND_IN_SILENT: 'Target.detachFromTarget' })
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const started = Date.now()

    const result = await readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps())

    expect(result.cookies.map((c) => c.name)).toEqual(['session'])
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('a connect that times out is reported as the browser not answering, not as a bare timeout', async () => {
    writeFileSync(join(udd, 'DevToolsActivePort'), '9222\n/devtools/browser/stand-in\n')
    const connect = vi.fn(async () => {
      throw new Error('timeout')
    })

    await expect(readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps({ connect, openSetupPage: vi.fn() }))).rejects.toThrow(
      'Chrome did not answer. Try the import again.',
    )
  })

  it('a cancel while waiting for the browser to turn remote debugging on rejects with cancelled', async () => {
    const openSetupPage = vi.fn()
    const read = readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps({ openSetupPage, setupTimeoutMs: 60_000 }))
    await waitFor(() => openSetupPage.mock.calls.length === 1)

    controller.abort()

    await expect(read).rejects.toThrow('cancelled')
  })

  it('rejects with a message to check remote debugging when the browser never offers a connection', async () => {
    const openSetupPage = vi.fn()

    await expect(readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps({ openSetupPage, setupTimeoutMs: 200 }))).rejects.toThrow(
      'Chrome did not offer a connection. Check that remote debugging is on.',
    )
    expect(openSetupPage).toHaveBeenCalledTimes(1)
  })

  it('rejects asking for an open window when the browser has no page of any profile', async () => {
    writeContexts([])
    startStandIn()
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))

    await expect(readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps())).rejects.toThrow(
      'Open a window of the profile in Chrome first.',
    )
  })

  it('a stale DevToolsActivePort, with a port nothing listens on, counts as remote debugging not on', async () => {
    const free = await new Promise<number>((resolvePort) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as { port: number }).port
        probe.close(() => resolvePort(port))
      })
    })
    // a path no stand-in serves, so another run's stand-in on the same port cannot answer
    writeFileSync(join(udd, 'DevToolsActivePort'), `${free}\n/devtools/browser/not-this-browser\n`)
    const openSetupPage = vi.fn()

    await expect(readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps({ openSetupPage, setupTimeoutMs: 200 }))).rejects.toThrow(
      'did not offer a connection',
    )
    expect(openSetupPage).toHaveBeenCalledTimes(1)
  })

  it('a malformed DevToolsActivePort never connects, and counts as remote debugging not on', async () => {
    const connect = vi.fn(connectCdp)
    const openSetupPage = vi.fn()
    const malformed = [
      '99999\n/devtools/browser/stand-in\n', // port out of range
      '0\n/devtools/browser/stand-in\n', // port zero
      '9222\n/devtools/browser/../../x\n', // a path outside the browser endpoint
      '9222\nhttp://example.com/devtools/browser/x\n', // not a path
    ]
    for (const text of malformed) {
      writeFileSync(join(udd, 'DevToolsActivePort'), text)
      await expect(readLiveCookies(liveSource(), Math.floor(Date.now() / 1000), makeDeps({ connect, openSetupPage, setupTimeoutMs: 100 }))).rejects.toThrow(
        'did not offer a connection',
      )
    }
    expect(connect).not.toHaveBeenCalled()
    expect(openSetupPage).toHaveBeenCalledTimes(malformed.length)
  })
})

describe('connectCdp', () => {
  it('rejects a send that gets no answer after its limit', async () => {
    startStandIn()
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const sock = await connectTo()
    try {
      await expect(sock.send('Stand.noAnswer', {}, undefined, 150)).rejects.toThrow('Stand.noAnswer did not answer')
    } finally {
      sock.close()
    }
  })

  it('rejects the pending sends with Connection closed when the reader closes the socket', async () => {
    startStandIn()
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const sock = await connectTo()
    const pending = sock.send('Stand.noAnswer', {}, undefined, 30_000)
    sock.close()

    await expect(pending).rejects.toThrow('Connection closed')
  })

  it('rejects the pending sends with Connection closed when the browser goes away', async () => {
    const child = startStandIn()
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const sock = await connectTo()
    const pending = sock.send('Stand.noAnswer', {}, undefined, 30_000)
    // the handler is attached before the kill: the send rejects as soon as the browser's socket drops
    const rejected = expect(pending).rejects.toThrow('Connection closed')
    const exited = new Promise((r) => child.once('exit', r))
    child.kill()
    await exited

    await rejected
    sock.close()
  })

  it('rejects Target.attachToTarget without flatten, as the browser does', async () => {
    startStandIn()
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const sock = await connectTo()
    try {
      await expect(sock.send('Target.attachToTarget', { targetId: 'page-1' })).rejects.toThrow('Target.attachToTarget failed')
    } finally {
      sock.close()
    }
  })

  it('refuses a connection to any endpoint other than the browser one', async () => {
    startStandIn()
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const port = readUrl().match(/:(\d+)\//)?.[1]

    await expect(connectCdp(`ws://127.0.0.1:${port}/devtools/browser/other`, () => {}, controller.signal)).rejects.toThrow('refused')
  })

  it('ignores messages that are not JSON objects', async () => {
    startStandIn()
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const sock = await connectTo()
    try {
      await expect(sock.send('Stand.junk')).resolves.toEqual({ ok: true })
    } finally {
      sock.close()
    }
  })

  it('rejects refused when nothing listens on the port', async () => {
    const free = await new Promise<number>((resolvePort) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as { port: number }).port
        probe.close(() => resolvePort(port))
      })
    })

    await expect(connectCdp(`ws://127.0.0.1:${free}/devtools/browser/stand-in`, () => {}, controller.signal)).rejects.toThrow('refused')
  })

  it('rejects cancelled when aborted while connecting', async () => {
    startStandIn({ STAND_IN_ALLOW_MS: '5000' })
    await waitFor(() => existsSync(join(udd, 'DevToolsActivePort')))
    const url = readUrl()
    const pendingAbort = new AbortController()
    const connecting = connectCdp(url, () => {}, pendingAbort.signal)
    setTimeout(() => pendingAbort.abort(), 100)

    await expect(connecting).rejects.toThrow('cancelled')
  })

  async function connectTo(): Promise<CdpSocket> {
    return connectCdp(readUrl(), () => {}, controller.signal)
  }

  function readUrl(): string {
    const [port, path] = readFileSync(join(udd, 'DevToolsActivePort'), 'utf8').split('\n')
    return `ws://127.0.0.1:${port}${path}`
  }
})
