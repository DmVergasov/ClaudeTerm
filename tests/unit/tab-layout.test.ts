import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TabLayoutStore } from '../../src/main/tab-layout'

const dir = (): string => mkdtempSync(join(tmpdir(), 'ct-tab-layout-'))

describe('TabLayoutStore', () => {
  it('a missing file means the default width and no folded groups', () => {
    expect(new TabLayoutStore(dir()).get()).toEqual({ width: 240, folded: [] })
  })

  it('keeps the width for the next run', () => {
    const d = dir()
    new TabLayoutStore(d).set({ width: 300 })
    expect(new TabLayoutStore(d).get()).toEqual({ width: 300, folded: [] })
    expect(JSON.parse(readFileSync(join(d, 'tab-layout.json'), 'utf8'))).toEqual({ width: 300, folded: [] })
  })

  it('a change of the folded groups keeps the width', () => {
    const d = dir()
    const store = new TabLayoutStore(d)
    store.set({ width: 300 })
    store.set({ folded: ['k'] })
    expect(store.get()).toEqual({ width: 300, folded: ['k'] })
    expect(new TabLayoutStore(d).get()).toEqual({ width: 300, folded: ['k'] })
  })

  it('clamps a width outside 220 to 480 on set and on read', () => {
    const d = dir()
    const store = new TabLayoutStore(d)
    store.set({ width: 9000 })
    expect(store.get().width).toBe(480)
    store.set({ width: 10 })
    expect(store.get().width).toBe(220)
    writeFileSync(join(d, 'tab-layout.json'), JSON.stringify({ width: 9999, folded: [] }))
    expect(new TabLayoutStore(d).get().width).toBe(480)
  })

  it('a corrupt file means the defaults, is reported, and is replaced by the next change', () => {
    const d = dir()
    const errors: string[] = []
    const path = join(d, 'tab-layout.json')
    writeFileSync(path, '{not json')
    const store = new TabLayoutStore(d, (m) => errors.push(m))
    expect(store.get()).toEqual({ width: 240, folded: [] })
    expect(errors).toEqual([`ignoring corrupt ${path}`])
    store.set({ width: 260 })
    expect(new TabLayoutStore(d).get()).toEqual({ width: 260, folded: [] })
  })

  it('a file of the wrong shape means the defaults and is reported', () => {
    const d = dir()
    const errors: string[] = []
    writeFileSync(join(d, 'tab-layout.json'), JSON.stringify([1, 2]))
    expect(new TabLayoutStore(d, (m) => errors.push(m)).get()).toEqual({ width: 240, folded: [] })
    expect(errors).toHaveLength(1)
  })

  it('drops non-string entries of folded', () => {
    const d = dir()
    writeFileSync(join(d, 'tab-layout.json'), JSON.stringify({ width: 240, folded: ['a', 7, null, 'b', { x: 1 }] }))
    expect(new TabLayoutStore(d).get().folded).toEqual(['a', 'b'])
  })

  it('a folder that cannot be written does not throw; the change lasts for this run', () => {
    const errors: string[] = []
    const store = new TabLayoutStore(join(dir(), 'missing', 'deeper'), (m) => errors.push(m))
    expect(() => store.set({ width: 300 })).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^cannot save /)
    expect(store.get().width).toBe(300)
  })
})
