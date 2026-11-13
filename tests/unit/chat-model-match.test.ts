import { describe, expect, it } from 'vitest'
import type { ChatModelInfo } from '../../src/shared/chat'
import { findModel, newestModels } from '../../src/renderer/chat/model-picker'

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

describe('newestModels', () => {
  // the list Claude Code gives, in its order: the default, then the models of four families, newest and older
  const list: ChatModelInfo[] = [
    model('default', 'Default (recommended)', 'claude-opus-5-5'),
    model('opus', 'Opus 5.5'),
    model('fable', 'Fable 5.2'),
    model('sonnet', 'Sonnet 5.5'),
    model('haiku', 'Haiku 5.5'),
    model('claude-fable-5-1', 'Fable 5.1'),
    model('claude-haiku-4-5', 'Haiku 4.5'),
    model('claude-sonnet-5', 'Sonnet 5'),
    model('claude-opus-5', 'Opus 5'),
    model('claude-fable-5', 'Fable 5')
  ]
  const names = (models: ChatModelInfo[]): string[] => models.map((m) => m.displayName)

  it('shows the default and the newest model of each family, in the list\'s order; the older ones are more', () => {
    const { shown, more } = newestModels(list, null)
    expect(names(shown)).toEqual(['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5'])
    expect(names(more)).toEqual(['Fable 5.1', 'Haiku 4.5', 'Sonnet 5', 'Opus 5', 'Fable 5'])
  })

  it('shows the picked model in its place even when it is an older one', () => {
    const { shown, more } = newestModels(list, 'claude-haiku-4-5')
    expect(names(shown)).toEqual(['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'Haiku 4.5'])
    expect(names(more)).not.toContain('Haiku 4.5')
  })

  it('compares versions as numbers, keeps every entry of the newest version, and shows a name it cannot read', () => {
    const { shown, more } = newestModels([
      model('a', 'Opus 5.9'), model('b', 'Opus 5.10'), model('c', 'Opus 5.10 (1M context)'), model('proxy', 'my-proxy-model')
    ], null)
    expect(names(shown)).toEqual(['Opus 5.10', 'Opus 5.10 (1M context)', 'my-proxy-model'])
    expect(names(more)).toEqual(['Opus 5.9'])
  })

  it('a list with nothing older has no more', () => {
    expect(newestModels(list.slice(0, 5), null).more).toEqual([])
  })
})
