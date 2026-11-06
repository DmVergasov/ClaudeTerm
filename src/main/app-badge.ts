/**
 * The badge of the tabs that need you: a count on the Dock icon (macOS) and the launcher (Linux), a dot over the taskbar
 * button (Windows), whose description holds the count.
 */

/** a round dot of `size` px in the color, as the BGRA pixels nativeImage.createFromBitmap takes; its edge is smoothed */
export function dotBitmap(size: number, [r, g, b]: [number, number, number]): Buffer {
  const px = Buffer.alloc(size * size * 4)
  const c = size / 2
  const radius = size / 2 - 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      const alpha = Math.max(0, Math.min(1, radius + 0.5 - d))
      const i = (y * size + x) * 4
      px[i] = b
      px[i + 1] = g
      px[i + 2] = r
      px[i + 3] = Math.round(alpha * 255)
    }
  }
  return px
}

export const badgeDescription = (n: number): string => (n === 1 ? '1 tab needs you' : `${n} tabs need you`)
