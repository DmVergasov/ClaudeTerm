import { describe, expect, it } from 'vitest'
import { MAX_URL, parseBrowserCommand, parseBrowserTabState } from '../../src/shared/browser'

const ref = 'e12'

describe('parseBrowserCommand: valid commands', () => {
  it('parses each op with its fields', () => {
    const ok = (command: unknown) => ({ ok: true, command })
    expect(parseBrowserCommand({ op: 'navigate', url: 'http://localhost:3000/' })).toEqual(ok({ op: 'navigate', url: 'http://localhost:3000/' }))
    expect(parseBrowserCommand({ op: 'back' })).toEqual(ok({ op: 'back' }))
    expect(parseBrowserCommand({ op: 'forward' })).toEqual(ok({ op: 'forward' }))
    expect(parseBrowserCommand({ op: 'reload' })).toEqual(ok({ op: 'reload' }))
    expect(parseBrowserCommand({ op: 'snapshot' })).toEqual(ok({ op: 'snapshot' }))
    expect(parseBrowserCommand({ op: 'press_key', key: 'Enter' })).toEqual(ok({ op: 'press_key', key: 'Enter' }))
    expect(parseBrowserCommand({ op: 'hover', ref, element: 'Menu' })).toEqual(ok({ op: 'hover', ref, element: 'Menu' }))
    expect(parseBrowserCommand({ op: 'select_option', ref, element: 'Size', values: ['L', 'XL'] }))
      .toEqual(ok({ op: 'select_option', ref, element: 'Size', values: ['L', 'XL'] }))
    expect(parseBrowserCommand({ op: 'console', onlyErrors: true })).toEqual(ok({ op: 'console', onlyErrors: true }))
    expect(parseBrowserCommand({ op: 'network' })).toEqual(ok({ op: 'network' }))
    expect(parseBrowserCommand({ op: 'network_request', id: 'r7' })).toEqual(ok({ op: 'network_request', id: 'r7' }))
    expect(parseBrowserCommand({ op: 'handle_dialog', accept: false, promptText: 'no' }))
      .toEqual(ok({ op: 'handle_dialog', accept: false, promptText: 'no' }))
    expect(parseBrowserCommand({ op: 'evaluate', function: '() => document.title', ref }))
      .toEqual(ok({ op: 'evaluate', function: '() => document.title', ref }))
  })

  it('fills the defaults of click, type, scroll, screenshot, wait_for and tabs', () => {
    expect(parseBrowserCommand({ op: 'click', ref, element: 'Save' }))
      .toEqual({ ok: true, command: { op: 'click', ref, element: 'Save', button: 'left', doubleClick: false } })
    expect(parseBrowserCommand({ op: 'type', ref, element: 'Name', text: 'Ada' }))
      .toEqual({ ok: true, command: { op: 'type', ref, element: 'Name', text: 'Ada', submit: false, slowly: false } })
    expect(parseBrowserCommand({ op: 'scroll', direction: 'down' }))
      .toEqual({ ok: true, command: { op: 'scroll', direction: 'down', amount: 600, ref: null } })
    expect(parseBrowserCommand({ op: 'screenshot' }))
      .toEqual({ ok: true, command: { op: 'screenshot', fullPage: false, ref: null } })
    expect(parseBrowserCommand({ op: 'wait_for', text: 'Done' }))
      .toEqual({ ok: true, command: { op: 'wait_for', text: 'Done', textGone: null, time: null } })
    expect(parseBrowserCommand({ op: 'tabs', action: 'list' }))
      .toEqual({ ok: true, command: { op: 'tabs', action: 'list', index: null, url: null } })
  })

  it('takes a click with the other buttons, and a scroll of 10000', () => {
    expect(parseBrowserCommand({ op: 'click', ref, element: 'Save', button: 'right', doubleClick: true }))
      .toEqual({ ok: true, command: { op: 'click', ref, element: 'Save', button: 'right', doubleClick: true } })
    expect(parseBrowserCommand({ op: 'scroll', direction: 'up', amount: 10000 }).ok).toBe(true)
  })

  it('takes a wait of 60 seconds and a new tab with a url', () => {
    expect(parseBrowserCommand({ op: 'wait_for', time: 60 }).ok).toBe(true)
    expect(parseBrowserCommand({ op: 'tabs', action: 'new', url: 'http://localhost:3000/' }))
      .toEqual({ ok: true, command: { op: 'tabs', action: 'new', index: null, url: 'http://localhost:3000/' } })
    expect(parseBrowserCommand({ op: 'tabs', action: 'select', index: 0 }))
      .toEqual({ ok: true, command: { op: 'tabs', action: 'select', index: 0, url: null } })
  })

  it('takes null for an optional field as the default', () => {
    expect(parseBrowserCommand({ op: 'click', ref, element: 'Save', button: null, doubleClick: null }))
      .toEqual({ ok: true, command: { op: 'click', ref, element: 'Save', button: 'left', doubleClick: false } })
    expect(parseBrowserCommand({ op: 'scroll', direction: 'down', amount: null, ref: null }))
      .toEqual({ ok: true, command: { op: 'scroll', direction: 'down', amount: 600, ref: null } })
    expect(parseBrowserCommand({ op: 'wait_for', text: null, textGone: 'Loading', time: null }))
      .toEqual({ ok: true, command: { op: 'wait_for', text: null, textGone: 'Loading', time: null } })
  })
})

describe('parseBrowserCommand: refused commands', () => {
  // refused, and the error text names the field or rule that failed
  const refusedFor = (v: unknown, named: string) => expect(parseBrowserCommand(v)).toEqual({ ok: false, error: expect.stringContaining(named) })

  it('refuses an unknown op', () => {
    refusedFor({ op: 'fly' }, 'unknown browser op: fly')
  })

  it('refuses a command that is no object: a string, null or an array', () => {
    refusedFor('navigate', 'command must be an object')
    refusedFor(null, 'command must be an object')
    refusedFor([], 'command must be an object')
    refusedFor([{ op: 'snapshot' }], 'command must be an object')
  })

  it('refuses navigate without a url, or a url over 8192 characters', () => {
    refusedFor({ op: 'navigate' }, 'url')
    refusedFor({ op: 'navigate', url: 'https://a.example/' + 'x'.repeat(MAX_URL) }, 'url')
  })

  it('refuses a ref that is not a snapshot ref, and a ref of the wrong type', () => {
    refusedFor({ op: 'hover', ref: 'x1', element: 'Menu' }, 'ref')
    refusedFor({ op: 'hover', ref: 5, element: 'Menu' }, 'ref')
    refusedFor({ op: 'scroll', direction: 'down', ref: 5 }, 'ref')
  })

  it('refuses a type text over 20000 characters and an evaluate function over 30000', () => {
    refusedFor({ op: 'type', ref, element: 'Name', text: 'x'.repeat(20001) }, 'text')
    refusedFor({ op: 'evaluate', function: 'x'.repeat(30001), ref: null }, 'function')
  })

  it('refuses a wait of 61 seconds, a wait with no field at all, and a wait of 0, -1, NaN or a string', () => {
    refusedFor({ op: 'wait_for', time: 61 }, 'time')
    refusedFor({ op: 'wait_for' }, 'textGone')
    for (const time of [0, -1, NaN, '5']) refusedFor({ op: 'wait_for', time }, 'time')
  })

  it('refuses a scroll of 0 or 10001, a fractional or negative amount, and an amount that is a string', () => {
    refusedFor({ op: 'scroll', direction: 'down', amount: 0 }, 'amount')
    refusedFor({ op: 'scroll', direction: 'down', amount: 10001 }, 'amount')
    refusedFor({ op: 'scroll', direction: 'down', amount: 1.5 }, 'amount')
    refusedFor({ op: 'scroll', direction: 'down', amount: -1 }, 'amount')
    refusedFor({ op: 'scroll', direction: 'down', amount: '600' }, 'amount')
  })

  it('refuses a select_option with 51 values, an empty list, a non-string value, and no element', () => {
    refusedFor({ op: 'select_option', ref, element: 'Size', values: Array.from({ length: 51 }, (_, i) => `v${i}`) }, 'values')
    refusedFor({ op: 'select_option', ref, element: 'Size', values: [] }, 'values')
    refusedFor({ op: 'select_option', ref, element: 'Size', values: [1] }, 'values')
    refusedFor({ op: 'select_option', ref, values: ['L'] }, 'element')
  })

  it('refuses a missing element on click', () => {
    refusedFor({ op: 'click', ref }, 'element')
  })

  it('refuses a network_request id that is not r followed by digits', () => {
    refusedFor({ op: 'network_request', id: '5' }, 'id')
  })

  it('refuses a tabs action that is unknown', () => {
    refusedFor({ op: 'tabs', action: 'open' }, 'action')
  })

  it('refuses a tabs select or close without an index, and an index that is negative, fractional or a string', () => {
    refusedFor({ op: 'tabs', action: 'select' }, 'index')
    refusedFor({ op: 'tabs', action: 'close' }, 'index')
    refusedFor({ op: 'tabs', action: 'select', index: -1 }, 'index')
    refusedFor({ op: 'tabs', action: 'select', index: 1.5 }, 'index')
    refusedFor({ op: 'tabs', action: 'close', index: '1' }, 'index')
  })

  it('refuses an empty key', () => {
    refusedFor({ op: 'press_key', key: '' }, 'key')
  })

  it('refuses a field of the wrong type, and names the field', () => {
    refusedFor({ op: 'click', ref, element: 'Save', button: 'wheel' }, 'button')
  })

  it('refuses a boolean field given as a string or a number, and names the field', () => {
    refusedFor({ op: 'click', ref, element: 'Save', doubleClick: 'yes' }, 'doubleClick')
    refusedFor({ op: 'type', ref, element: 'Name', text: 'Ada', submit: 1 }, 'submit')
    refusedFor({ op: 'type', ref, element: 'Name', text: 'Ada', slowly: 'no' }, 'slowly')
  })

  it('refuses handle_dialog without accept, and names the field', () => {
    refusedFor({ op: 'handle_dialog' }, 'accept')
    refusedFor({ op: 'handle_dialog', accept: 'yes' }, 'accept')
  })
})

describe('parseBrowserTabState', () => {
  it('keeps a state as it is', () => {
    const state = { profile: 'default', pages: ['http://localhost:1/'], current: 0 }
    expect(parseBrowserTabState(state)).toEqual(state)
  })

  it('drops a page that is no web page and clamps current into range', () => {
    expect(parseBrowserTabState({ profile: 'default', pages: ['javascript:x', 'http://localhost:1/'], current: 5 }))
      .toEqual({ profile: 'default', pages: ['http://localhost:1/'], current: 0 })
  })

  it('gives null for a bad profile id', () => {
    expect(parseBrowserTabState({ profile: 'Bad Name', pages: [], current: 0 })).toBeNull()
  })

  it('cuts more than 20 pages to 20', () => {
    const pages = Array.from({ length: 25 }, (_, i) => `http://localhost:${i + 1}/`)
    const state = parseBrowserTabState({ profile: 'default', pages, current: 0 })
    expect(state?.pages).toHaveLength(20)
    expect(state?.pages[19]).toBe('http://localhost:20/')
  })
})
