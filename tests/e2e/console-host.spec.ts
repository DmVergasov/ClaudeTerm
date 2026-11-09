import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { WIN } from '../fixtures/platform'
import { bufferText, launchApp, PROMPT, TEST_SHELL } from './helpers'

/** the names of the processes the process `parent` started, lower case */
function children(parent: number): string[] {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent}").Name`], { encoding: 'utf8' })
  return out.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
}

// Windows' own ConPTY (conhost) of Windows 11 24H2 left lines of Claude Code's fullscreen screen behind or doubled them until
// the window was resized; tabs run in the ConPTY bundled with node-pty (Windows Terminal's) unless conpty is "system"
for (const [conpty, host, other] of [[undefined, 'openconsole.exe', 'conhost.exe'], ['system', 'conhost.exe', 'openconsole.exe']] as const) {
  test(`a tab runs in ${host} with conpty ${conpty ?? 'left out'}`, async () => {
    test.skip(!WIN, 'ConPTY is Windows only')
    const { app, page } = await launchApp({ settings: { defaultProfile: TEST_SHELL, ...(conpty ? { conpty } : {}) } })
    try {
      await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
      await expect.poll(() => bufferText(page), { timeout: 20_000 }).toMatch(PROMPT)
      // the main process: on Windows app.process() is the launcher that started it
      const appPid = await app.evaluate(() => process.pid)
      const names = children(appPid)
      expect(names).toContain(host)
      expect(names).not.toContain(other)
    } finally {
      await app.close()
    }
  })
}
