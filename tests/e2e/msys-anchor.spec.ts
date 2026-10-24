import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WIN } from '../fixtures/platform'
import { FAKE_CLAUDE_SETTINGS, launchApp } from './helpers'

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const ANCHOR = 'C:\\Program Files\\Git\\usr\\bin\\sleep.exe'

/** the processes the process `parent` started from `file` */
function started(parent: number, file: string): number[] {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent}" | Where-Object { $_.ExecutablePath -eq '${file}' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' })
  return out.split(/\r?\n/).filter((l) => l.trim()).map(Number)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Git Bash broke for good (every bash, hook and git credential helper waited 15 s and died with "add_item (...) failed,
// errno 1") once a starting bash was killed at the wrong moment, which a Claude tab's statusLine, run every few seconds
// through Git Bash, made likely. An idle process of Git's runtime that lives as long as the app keeps that from happening.
test('Claude tabs keep one idle Git Bash process running, and it ends with the app', async () => {
  test.skip(!WIN || !existsSync(ANCHOR), 'Git for Windows only')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work], env: { CLAUDE_CODE_GIT_BASH_PATH: GIT_BASH } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  // the main process: on Windows app.process() is the launcher that started it
  const appPid = await app.evaluate(() => process.pid)
  await expect.poll(() => started(appPid, ANCHOR).length).toBe(1)
  const [anchor] = started(appPid, ANCHOR)
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  expect(started(appPid, ANCHOR)).toEqual([anchor])
  await app.close()
  await expect.poll(() => alive(anchor)).toBe(false)
})
