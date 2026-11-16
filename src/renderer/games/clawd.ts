/** Clawd from Claude Code's welcome screen: 18 × 5 pixels, each twice as tall as wide; '#' is filled */
export const CLAWD: readonly string[] = [
  '...############...',
  '...##.######.##...',
  '.################.',
  '...############...',
  '....#.#....#.#....'
]

/** the second running frame: the legs one pixel to the left */
export const CLAWD_STEP: readonly string[] = [...CLAWD.slice(0, 4), '...#.#....#.#.....']

/** ducking: the top row dropped */
export const CLAWD_DUCK: readonly string[] = CLAWD.slice(1)

/** paints rows at (x, y) top-left, `unit` px wide and 2 × unit tall per pixel */
export function paintSprite(
  ctx: CanvasRenderingContext2D,
  rows: readonly string[],
  x: number,
  y: number,
  unit: number,
  color: string
): void {
  ctx.fillStyle = color
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] === '#') ctx.fillRect(x + c * unit, y + r * 2 * unit, unit, 2 * unit)
    }
  })
}
