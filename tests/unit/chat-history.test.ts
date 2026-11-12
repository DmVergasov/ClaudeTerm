import { describe, expect, it } from 'vitest'
import { typedMessages, type ChatItem } from '../../src/shared/chat'
import { ChatModel } from '../../src/main/chat/chat-model'

const user = (id: string, text: string, from?: 'auto' | 'review'): ChatItem => ({
  kind: 'user', id, text, attachments: [], queued: false, ...(from === undefined ? {} : { from })
})

describe('typedMessages', () => {
  it('recalls the messages the user typed, oldest first', () => {
    const items: ChatItem[] = [user('1', 'first'), { kind: 'text', id: '2', markdown: 'an answer', streaming: false }, user('3', 'second')]
    expect(typedMessages(items)).toEqual(['first', 'second'])
  })

  it("leaves out an auto-continue prompt and a Review Send text: they are not the user's", () => {
    const items: ChatItem[] = [user('1', 'typed'), user('2', 'continue', 'auto'), user('3', 'please review', 'review')]
    expect(typedMessages(items)).toEqual(['typed'])
  })

  it('leaves out an empty text', () => {
    expect(typedMessages([user('1', ''), user('2', 'typed')])).toEqual(['typed'])
  })
})

describe('a message sent with its origin', () => {
  it('keeps where it came from on its item', () => {
    const m = new ChatModel({ now: () => 0, newId: () => 'id', folder: () => '/work/acme' })
    const patches = m.userSent({ text: 'continue', attachments: [], from: 'auto' })
    expect(patches).toContainEqual(expect.objectContaining({ op: 'add', item: expect.objectContaining({ kind: 'user', from: 'auto' }) }))
  })
})
