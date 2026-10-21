import { describe, expect, it } from 'vitest'
import { checkOnce } from '../../src/main/image-paste'

describe('checkOnce', () => {
  it('runs the check at the first call only and answers every call, also one made while it runs, with its result', async () => {
    let runs = 0
    let finish: (ok: boolean) => void = () => {}
    const check = checkOnce(() => {
      runs++
      return new Promise<boolean>((resolve) => { finish = resolve })
    })
    const first = check()
    const during = check()
    finish(false)
    expect(await first).toBe(false)
    expect(await during).toBe(false)
    expect(await check()).toBe(false)
    expect(runs).toBe(1)
  })
})
