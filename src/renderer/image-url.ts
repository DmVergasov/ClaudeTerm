import type { ImageCard } from '../shared/types'

export function imageUrl(card: ImageCard): string {
  return `ctimg://${card.id}/?v=${card.version}`
}
