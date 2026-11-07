/** A point in the sync order: wall-clock milliseconds, then a counter for writes in the same millisecond. */
export interface Stamp {
  t: number
  c: number
}

/**
 * A hybrid logical clock: stamps only move forward, even when the wall clock goes back
 * or a peer's stamp is ahead of this device's own clock.
 */
export class Clock {
  private stamp: Stamp
  private readonly clock: () => number

  constructor(last: Stamp | null, now: () => number) {
    this.stamp = last ? { t: last.t, c: last.c } : { t: 0, c: 0 }
    this.clock = now
  }

  /** The stamp for a new local write. */
  now(): Stamp {
    const pt = this.clock()
    this.stamp = pt > this.stamp.t ? { t: pt, c: 0 } : { t: this.stamp.t, c: this.stamp.c + 1 }
    return { ...this.stamp }
  }

  /** Moves the clock past a stamp seen from another device. */
  observe(s: Stamp): void {
    if (s.t > this.stamp.t || (s.t === this.stamp.t && s.c > this.stamp.c)) this.stamp = { t: s.t, c: s.c }
  }

  last(): Stamp {
    return { ...this.stamp }
  }
}

/** Orders two stamps by time, then counter, then the writing device's id. */
export function compareStamps(a: Stamp, aBy: string, b: Stamp, bBy: string): number {
  if (a.t !== b.t) return a.t - b.t
  if (a.c !== b.c) return a.c - b.c
  return aBy < bBy ? -1 : aBy > bBy ? 1 : 0
}
