import { describe, expect, it } from 'vitest'
import type { ChatModelInfo } from '../../src/shared/chat'
import { findModel } from '../../src/renderer/chat/model-picker'

const model = (value: string, displayName: string, resolved?: string): ChatModelInfo => ({
  value,
  displayName,
  description: '',
  efforts: ['low', 'high'],
  ...(resolved === undefined ? {} : { resolved })
})

describe('findModel', () => {
  const list: ChatModelInfo[] = [
    model('default', 'Default (recommended)', 'claude-opus-5-5'),
    model('opus', 'Opus 5.5', 'claude-opus-5-5'),
    model('haiku', 'Haiku 5.5', 'claude-haiku-5-5')
  ]

  it('finds an entry by its value', () => {
    expect(findModel(list, 'haiku')?.displayName).toBe('Haiku 5.5')
  })

  it('finds an entry by the resolved id the stream names, when no value matches', () => {
    expect(findModel(list, 'claude-haiku-5-5')?.value).toBe('haiku')
  })

  it('prefers an entry whose value is not default when a resolved id matches both', () => {
    expect(findModel(list, 'claude-opus-5-5')?.value).toBe('opus')
    const reversed = [model('opus', 'Opus 5.5', 'claude-opus-5-5'), model('default', 'Default', 'claude-opus-5-5')]
    expect(findModel(reversed, 'claude-opus-5-5')?.value).toBe('opus')
  })

  it('takes the default entry when it is the only one that matches', () => {
    expect(findModel([model('default', 'Default', 'claude-opus-5-5')], 'claude-opus-5-5')?.value).toBe('default')
  })

  it('finds nothing with no match, no id, or an empty list', () => {
    expect(findModel(list, 'sonnet')).toBeUndefined()
    expect(findModel(list, null)).toBeUndefined()
    expect(findModel([], 'opus')).toBeUndefined()
  })
})
