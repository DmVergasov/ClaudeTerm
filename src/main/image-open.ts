import { checkOpenableFile, type ImageCheck } from '../shared/image-file'
import type { ImageCard } from '../shared/types'

/** Opens a card in the system app, re-checking the file first; a failure is reported, never opened. */
export async function openCard(
  card: ImageCard,
  deps: { imageExtensions: readonly string[]; openPath(path: string): Promise<string>; toast(message: string): void }
): Promise<void> {
  const check: ImageCheck = await checkOpenableFile(card.path, deps.imageExtensions)
  if (!check.ok) {
    deps.toast(check.error)
    return
  }
  const error = await deps.openPath(card.path)
  if (error) deps.toast(error)
}
