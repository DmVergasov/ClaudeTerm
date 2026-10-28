import { describe, expect, it, vi } from 'vitest'
import type { CardKind, ImageCard } from '../../src/shared/types'

// the panel's menu listens on the document when it loads; the pure helpers need none of it
vi.stubGlobal('document', { addEventListener: () => {} })
const { lightboxTarget } = await import('../../src/renderer/image-panel')

const card = (name: string, kind: CardKind): ImageCard => ({
  id: name, tabId: 't1', path: `D:\\proj\\${name}`, name, relPath: name, source: 'created', kind, caption: null, touchedAt: 0, version: 1, updated: false, deleted: false
})

describe('lightboxTarget', () => {
  const video = card('clip.mp4', 'video')
  const imgA = card('a.png', 'image')
  const audio = card('song.mp3', 'audio')
  const imgB = card('b.png', 'image')

  it('leaves out audio and video cards and points at the clicked image among the images', () => {
    expect(lightboxTarget([video, imgA, audio, imgB], 3)).toEqual({ cards: [imgA, imgB], index: 1 })
  })

  it('an image clicked after a video keeps its place among the images only', () => {
    expect(lightboxTarget([video, imgA], 1)).toEqual({ cards: [imgA], index: 0 })
  })

  it('an image list passes through unchanged', () => {
    expect(lightboxTarget([imgA, imgB], 1)).toEqual({ cards: [imgA, imgB], index: 1 })
  })
})
