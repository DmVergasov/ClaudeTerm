import { describe, expect, it } from 'vitest'
import { osc52Text } from '../../src/renderer/osc52'

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

describe('osc52Text', () => {
  it('decodes the text a program copies to the clipboard', () => {
    expect(osc52Text(`c;${b64('hello')}`)).toBe('hello')
  })

  it('decodes UTF-8', () => {
    expect(osc52Text(`c;${b64('Привет — ✓')}`)).toBe('Привет — ✓')
  })

  it('takes an empty target or one that names the clipboard among others', () => {
    expect(osc52Text(`;${b64('x')}`)).toBe('x')
    expect(osc52Text(`pc;${b64('x')}`)).toBe('x')
  })

  it('ignores targets other than the clipboard', () => {
    expect(osc52Text(`p;${b64('x')}`)).toBeNull()
    expect(osc52Text(`s0;${b64('x')}`)).toBeNull()
  })

  it('never answers a query for the clipboard contents', () => {
    expect(osc52Text('c;?')).toBeNull()
  })

  it('ignores broken data', () => {
    expect(osc52Text('c;not base64!')).toBeNull()
    expect(osc52Text('c;')).toBeNull()
    expect(osc52Text('c')).toBeNull()
    expect(osc52Text('')).toBeNull()
  })
})
