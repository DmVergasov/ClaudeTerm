import { describe, expect, it } from 'vitest'
import { quoteMarkdown, splitQuotes } from '../../src/renderer/chat/chat-quote'

describe('quoteMarkdown', () => {
  it('sends one quote as a blockquote line, an empty line, then the typed text', () => {
    expect(quoteMarkdown(['word'], 'my text')).toBe('> word\n\nmy text')
  })

  it('sends two quotes each in its own block, in the order given', () => {
    expect(quoteMarkdown(['first', 'second'], 'my text')).toBe('> first\n\n> second\n\nmy text')
  })

  it('puts every line of a multi-line quote in a blockquote line, and keeps the quote together', () => {
    expect(quoteMarkdown(['first\nsecond', 'third'], 'my text')).toBe('> first\n> second\n\n> third\n\nmy text')
  })

  it('quotes the blank line of a quote as a blockquote line too', () => {
    expect(quoteMarkdown(['a\n\nb'], 'x')).toBe('> a\n> \n> b\n\nx')
  })

  it('turns the CRLF line ends of a quote into lines', () => {
    expect(quoteMarkdown(['a\r\nb'], 'x')).toBe('> a\n> b\n\nx')
  })

  it('sends the quotes alone when there is no typed text, with no empty line after them', () => {
    expect(quoteMarkdown(['word'], '')).toBe('> word')
  })
})

describe('splitQuotes', () => {
  it('takes the leading quote off a message and leaves the typed text', () => {
    expect(splitQuotes('> word\n\nmy text')).toEqual({ quotes: ['word'], rest: 'my text' })
  })

  it('takes every leading quote, each block in its order, when an empty line comes between two of them', () => {
    expect(splitQuotes('> first\n\n> second\n> third\n\nmy text')).toEqual({ quotes: ['first', 'second\nthird'], rest: 'my text' })
  })

  it('takes quotes that have no typed text after them', () => {
    expect(splitQuotes('> a\n\n> b')).toEqual({ quotes: ['a', 'b'], rest: '' })
  })

  it('leaves a message with no leading quote as it is', () => {
    expect(splitQuotes('plain text')).toEqual({ quotes: [], rest: 'plain text' })
  })

  it('leaves a message whose > comes later in the text as it is', () => {
    expect(splitQuotes('a line\n> not a quote')).toEqual({ quotes: [], rest: 'a line\n> not a quote' })
    expect(splitQuotes('first\n\n> later')).toEqual({ quotes: [], rest: 'first\n\n> later' })
  })

  it('keeps a > that the quoted text itself starts with', () => {
    expect(splitQuotes('> > nested\n\ntext')).toEqual({ quotes: ['> nested'], rest: 'text' })
  })

  it('reads back what quoteMarkdown wrote', () => {
    const quotes = ['first', 'second\n\nwith a blank line', '> a quoted >']
    expect(splitQuotes(quoteMarkdown(quotes, 'my text\nsecond line'))).toEqual({ quotes, rest: 'my text\nsecond line' })
  })

  it('leaves a message that starts with >>> as typed text, not a quote', () => {
    expect(splitQuotes('>>> import x')).toEqual({ quotes: [], rest: '>>> import x' })
    expect(splitQuotes('>>> import x\n>>> print(x)')).toEqual({ quotes: [], rest: '>>> import x\n>>> print(x)' })
  })

  it('leaves a > that is not followed by a space as typed text', () => {
    expect(splitQuotes('>x\n\ntext')).toEqual({ quotes: [], rest: '>x\n\ntext' })
  })

  it('leaves a quote line that is not followed by an empty line or the end as typed text', () => {
    expect(splitQuotes('> a\ntext')).toEqual({ quotes: [], rest: '> a\ntext' })
    expect(splitQuotes('> a\n\n> b\ntext')).toEqual({ quotes: ['a'], rest: '> b\ntext' })
  })

  it('has no typed text in a message that is only quotes, so there is nothing to recall', () => {
    expect(splitQuotes('> word').rest).toBe('')
    expect(splitQuotes('> a\n\n> b').rest).toBe('')
  })
})
