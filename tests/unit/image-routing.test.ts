import { describe, expect, it } from 'vitest'
import { folderImageGoesTo } from '../../src/main/image-routing'

const AT = Date.parse('2026-10-06T12:00:00.000Z')
const tabs = (running: Record<string, boolean>) => Object.entries(running).map(([tabId, r]) => ({ tabId, toolRunningAt: (t: number) => t === AT && r }))

describe('folderImageGoesTo', () => {
  it('the only Claude tab in a folder gets every new image there', () => {
    expect(folderImageGoesTo('a', tabs({ a: false }), AT)).toBe(true)
  })

  it('with several Claude tabs in one folder, only those running a tool when the file was written get it', () => {
    const peers = tabs({ a: true, b: false, c: false })
    expect(folderImageGoesTo('a', peers, AT)).toBe(true)
    expect(folderImageGoesTo('b', peers, AT)).toBe(false)
    expect(folderImageGoesTo('c', peers, AT)).toBe(false)
  })

  it('when several of them were running tools, each of those gets it', () => {
    const peers = tabs({ a: true, b: true, c: false })
    expect(folderImageGoesTo('a', peers, AT)).toBe(true)
    expect(folderImageGoesTo('b', peers, AT)).toBe(true)
    expect(folderImageGoesTo('c', peers, AT)).toBe(false)
  })

  it('when none of them was running a tool (a dev server, the user), all of them get it', () => {
    const peers = tabs({ a: false, b: false })
    expect(folderImageGoesTo('a', peers, AT)).toBe(true)
    expect(folderImageGoesTo('b', peers, AT)).toBe(true)
  })
})
