import { spawn } from 'node:child_process'
import { copyFile } from 'node:fs/promises'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CdpPipe } from '../../src/main/browser-import/cdp-pipe'
import { readChromiumCookies } from '../../src/main/browser-import/chromium-reader'
import type { ImportSource } from '../../src/main/browser-import/sources'

// Opt-in: CLAUDETERM_REAL_BROWSER_TEST=1. It starts the installed Chrome twice on a THROWAWAY user-data folder under
// tmpdir(), never on the default profile. Only the browser this test started is ever sent Browser.close.

const NAME = 'claudeterm-spike-cookie'
const VALUE = 'test-value-real'

function findChrome(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [
          join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
  return candidates.find((p) => existsSync(p)) ?? null
}

const CHROME = findChrome()

// Sets one cookie in the throwaway profile through CDP, closes the browser this function started, and waits for it.
async function setCookieInThrowawayProfile(chrome: string, userData: string): Promise<void> {
  const child = spawn(
    chrome,
    [`--user-data-dir=${userData}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--headless=new'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  let exited = false
  child.on('error', () => undefined)
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  gone.then(() => (exited = true))
  const pipe = new CdpPipe(child.stdio[3] as NodeJS.WritableStream, child.stdio[4] as NodeJS.ReadableStream)
  try {
    await pipe.send('Storage.setCookies', {
      cookies: [
        {
          name: NAME,
          value: VALUE,
          domain: 'example.com',
          path: '/',
          secure: true,
          expires: Math.floor(Date.now() / 1000) + 3600,
        },
      ],
    })
    await pipe.send('Browser.close', {}, 30_000).catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([gone, new Promise<void>((resolve) => (timer = setTimeout(resolve, 10_000)))])
    clearTimeout(timer)
  } finally {
    pipe.close()
    if (!exited) child.kill()
    await gone
  }
}

describe.skipIf(process.env.CLAUDETERM_REAL_BROWSER_TEST !== '1' || CHROME === null)('Chrome import through a copy, real browser', () => {
  it('reads back a cookie set in a throwaway profile', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'ct-real-chrome-'))
    try {
      await setCookieInThrowawayProfile(CHROME as string, userData)
      const source: ImportSource = {
        id: 'chrome:Default',
        kind: 'chrome',
        browser: 'Chrome',
        label: 'Chrome · Default',
        family: 'chromium',
        mode: 'copy',
        userDataDir: userData,
        profileDir: join(userData, 'Default'),
        profileName: 'Default',
        email: null,
        hasCookies: true,
        binary: { file: CHROME as string, args: [] },
      }

      const result = await readChromiumCookies(source, Math.floor(Date.now() / 1000), {
        spawn,
        copyFile: (src, dst) => copyFile(src, dst),
        onWaiting: () => undefined,
        signal: new AbortController().signal,
        timeoutMs: 60_000,
      })

      expect(result.cookies.some((c) => c.name === NAME && c.value === VALUE)).toBe(true)
    } finally {
      rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 120_000)
})
