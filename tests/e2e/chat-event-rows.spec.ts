import { expect, test } from '@playwright/test'
import { launchChatTab, sendMessage } from './chat-helpers'

const TASK_NOTICE = [
  '<task-notification>',
  '<task-id>a1</task-id>',
  '<tool-use-id>t1</tool-use-id>',
  '<status>completed</status>',
  '<summary>Agent "Re-review Task 11 fix round" finished</summary>',
  '<result>Two findings, both fixed.</result>',
  '</task-notification>'
].join('\n')

const PEER_MESSAGE = '<cross-session-message from="s-2" name="Reviewer">Ready for review</cross-session-message>'

test('a background task notice Claude Code puts in the conversation is a compact row with its summary, not a bubble', async () => {
  const { app, page } = await launchChatTab({
    turns: { go: [{ text: 'Started the review.' }, { inject: { text: TASK_NOTICE, origin: { kind: 'task-notification' } } }, { text: 'Carrying on.' }] }
  })
  try {
    await sendMessage(page, 'go')
    await expect(page.locator('.chat-host:visible .chat-text', { hasText: 'Carrying on.' })).toHaveCount(1)
    const row = page.locator('.chat-host:visible .chat-event')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Agent "Re-review Task 11 fix round" finished')
    // the person's bubble is their own message only
    await expect(page.locator('.chat-host:visible .chat-user')).toHaveCount(1)
    await expect(page.locator('.chat-host:visible .chat-column')).not.toContainText('<task-notification>')
    // the row folds the result text under it
    await expect(row).not.toContainText('Two findings, both fixed.')
    await row.locator('.chat-event-head').click()
    await expect(row.locator('.chat-event-body')).toContainText('Two findings, both fixed.')
  } finally {
    await app.close()
  }
})

test('a message from another session is a row that names its sender, with the body folded under it', async () => {
  const { app, page } = await launchChatTab({
    turns: { go: [{ inject: { text: PEER_MESSAGE, origin: { kind: 'peer', from: 's-2', name: 'Reviewer', body: 'Ready for review' } } }, { text: 'Thanks.' }] }
  })
  try {
    await sendMessage(page, 'go')
    await expect(page.locator('.chat-host:visible .chat-text', { hasText: 'Thanks.' })).toHaveCount(1)
    const row = page.locator('.chat-host:visible .chat-event')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Message from Reviewer')
    await expect(page.locator('.chat-host:visible .chat-user')).toHaveCount(1)
    await row.locator('.chat-event-head').click()
    await expect(row.locator('.chat-event-body')).toContainText('Ready for review')
  } finally {
    await app.close()
  }
})
