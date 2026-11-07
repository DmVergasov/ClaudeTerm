import { describe, expect, it } from 'vitest'
import { RemoteImages } from '../../src/main/sync/remote-actions'
import { T1, T2, imageCard } from '../fixtures/host-context'

// The cards of other devices' tabs and the bytes this device keeps of them: a card is known as the tab that pushed it,
// bytes are kept for one version of a card, the least recently used go first, and a tab's cards go with the tab.

const A = imageCard(1, { tabId: T1 }).id
const B = imageCard(2, { tabId: T1 }).id
const C = imageCard(3, { tabId: T1 }).id
const D = imageCard(4, { tabId: T2 }).id

describe('RemoteImages', () => {
  it('knows the cards each tab pushed, and a tab that closes takes its cards with it', () => {
    const r = new RemoteImages()
    r.setCards(T1, [imageCard(1, { tabId: T1 }), imageCard(2, { tabId: T1 })])
    r.setCards(T2, [imageCard(4, { tabId: T2 })])
    expect(r.card(A)).toMatchObject({ tabId: T1, path: '/work/demo/img-1.png' })
    expect(r.card(D)).toMatchObject({ tabId: T2 })
    r.dropTab(T1)
    expect(r.card(A)).toBeNull()
    expect(r.card(B)).toBeNull()
    expect(r.card(D)).not.toBeNull()
  })

  it('a card a later push of its tab no longer lists is forgotten, with its bytes', () => {
    const r = new RemoteImages()
    r.setCards(T1, [imageCard(1, { tabId: T1 }), imageCard(2, { tabId: T1 })])
    r.store(A, 1, Buffer.from('a'))
    r.setCards(T1, [imageCard(2, { tabId: T1 })])
    expect(r.card(A)).toBeNull()
    expect(r.cached(A, 1)).toBeNull()
    expect(r.card(B)).not.toBeNull()
  })

  it('a card is known only as the tab it came from: a push that names another tab is ignored', () => {
    const r = new RemoteImages()
    r.setCards(T1, [imageCard(4, { tabId: T2 })])
    expect(r.card(D)).toBeNull()
  })

  it('cached gives the bytes stored for the card at its version, and nothing for another version', () => {
    const r = new RemoteImages()
    r.setCards(T1, [imageCard(1, { tabId: T1 })])
    r.store(A, 1, Buffer.from('one'))
    expect(r.cached(A, 1)?.toString()).toBe('one')
    expect(r.cached(A, 2)).toBeNull()
  })

  it('a push that changes the version of a card drops the bytes of the old version', () => {
    const r = new RemoteImages()
    r.setCards(T1, [imageCard(1, { tabId: T1 })])
    r.store(A, 1, Buffer.from('one'))
    r.setCards(T1, [imageCard(1, { tabId: T1, version: 2 })])
    expect(r.cached(A, 1)).toBeNull()
    expect(r.cached(A, 2)).toBeNull()
  })

  it('the least recently used bytes go first when the cache is full', () => {
    const r = new RemoteImages(10)
    r.setCards(T1, [imageCard(1, { tabId: T1 }), imageCard(2, { tabId: T1 }), imageCard(3, { tabId: T1 })])
    r.store(A, 1, Buffer.alloc(4))
    r.store(B, 1, Buffer.alloc(4))
    expect(r.cached(A, 1)).not.toBeNull()
    r.store(C, 1, Buffer.alloc(4))
    expect(r.cached(B, 1)).toBeNull()
    expect(r.cached(A, 1)).not.toBeNull()
    expect(r.cached(C, 1)).not.toBeNull()
  })

  it('bytes larger than the cache are not kept', () => {
    const r = new RemoteImages(10)
    r.setCards(T1, [imageCard(1, { tabId: T1 })])
    r.store(A, 1, Buffer.alloc(11))
    expect(r.cached(A, 1)).toBeNull()
  })

  it('bytes of a card that is not known are not kept', () => {
    const r = new RemoteImages()
    r.store(A, 1, Buffer.from('one'))
    expect(r.cached(A, 1)).toBeNull()
  })

  it('a card id another tab holds is not taken over by a push of a second tab', () => {
    const r = new RemoteImages()
    r.setCards(T1, [imageCard(1, { tabId: T1 })])
    r.setCards(T2, [imageCard(1, { tabId: T2 })])
    expect(r.card(A)).toMatchObject({ tabId: T1 })
    r.dropTab(T2)
    expect(r.card(A)).not.toBeNull()
  })

  it('bytes are kept only for the version the card has now: a version it has moved past is not kept', () => {
    const r = new RemoteImages()
    r.setCards(T1, [imageCard(1, { tabId: T1, version: 2 })])
    r.store(A, 1, Buffer.from('old'))
    expect(r.cached(A, 1)).toBeNull()
    r.store(A, 2, Buffer.from('new'))
    expect(r.cached(A, 2)?.toString()).toBe('new')
  })

  it('clear forgets every card and its bytes', () => {
    const r = new RemoteImages()
    r.setCards(T1, [imageCard(1, { tabId: T1 })])
    r.store(A, 1, Buffer.from('one'))
    r.clear()
    expect(r.card(A)).toBeNull()
    expect(r.cached(A, 1)).toBeNull()
  })
})
