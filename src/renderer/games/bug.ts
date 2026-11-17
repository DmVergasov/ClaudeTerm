/** a frame of the bug: 7 × 5 cells, each cell 2 px */
export const BUG: readonly string[] = ['#.###.#', '.#####.', '#######', '.#####.', '#.#.#.#']

/** paints a pixel-art sprite whose cells are 2 px, with its top-left at (x, y) */
export function paintPixels(ctx: CanvasRenderingContext2D, rows: readonly string[], x: number, y: number, color: string): void {
  ctx.fillStyle = color
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] === '#') ctx.fillRect(x + c * 2, y + r * 2, 2, 2)
    }
  })
}
