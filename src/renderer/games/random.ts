/** A seeded random source: the games' rules keep its seed in their state, so the same state and keys give the same step */
export interface Random {
  /** a number in [0, 1) */
  next(): number
  /** the seed to keep, so the next draw goes on from here */
  seed(): number
}

/** mulberry32: a small 32-bit generator, good enough for terrain, pieces and shades */
export function seeded(seed: number): Random {
  let a = seed >>> 0
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    seed: () => a
  }
}

/** a fresh seed for a new run */
export function newSeed(): number {
  return Math.floor(Math.random() * 4294967296) >>> 0
}
