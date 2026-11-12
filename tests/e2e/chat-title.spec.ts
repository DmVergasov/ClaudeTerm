import { expect, test, type Locator, type Page } from '@playwright/test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { launchChatTab, sendMessage } from './chat-helpers'

const row = (page: Page, id: string): Locator => page.locator(`#tabpanel .tp-tab[data-tab-id="${id}"] .tab-title`)

test("a chat tab is named after its session's title, as its terminal would be, and follows a later title", async () => {
  const { app, page, tabId, pipeName, work } = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] } }, { tabs: { position: 'left' } })
  try {
    await sendMessage(page, 'hello')
    await expect(page.locator('.chat-column')).toContainText('Hi there')
    await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
    // until the transcript names the session, the chat tab shows its project folder
    await expect(row(page, tabId)).toHaveText(basename(work))

    // the session's transcript, as Claude Code writes it: the session start reports it, as the hook does
    const sid = (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))!.state.sessionId!
    const transcript = join(mkdtempSync(join(tmpdir(), 'ct-title-')), `${sid}.jsonl`)
    writeFileSync(transcript, '')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: sid, source: 'startup', transcriptPath: transcript })).toEqual({ ok: true })

    // Claude Code's generated title: the tab shows it, not the folder
    appendFileSync(transcript, JSON.stringify({ type: 'ai-title', sessionId: sid, aiTitle: 'Fix the login redirect' }) + '\n')
    await expect(row(page, tabId)).toHaveText('Fix the login redirect', { timeout: 20_000 })

    // a rename in Claude Code (/rename) wins over the generated title
    appendFileSync(transcript, JSON.stringify({ type: 'custom-title', sessionId: sid, customTitle: 'Login work' }) + '\n')
    await expect(row(page, tabId)).toHaveText('Login work', { timeout: 20_000 })
  } finally {
    await app.close()
  }
})
