import { describe, expect, it, vi } from 'vitest'
import { cardId, ImageHub, relPathOf } from '../../src/main/image-hub'

function hub(maxItems = 200) {
  const onChange = vi.fn()
  let t = 1000
  return { h: new ImageHub({ maxItems: () => maxItems, onChange, now: () => ++t }), onChange }
}

describe('ImageHub', () => {
  it('adds new cards on top with relative paths', () => {
    const { h, onChange } = hub()
    h.addTab('t1', 'D:\\proj')
    h.add('t1', 'D:\\proj\\out\\a.png', 'created', null)
    h.add('t1', 'C:\\Temp\\b.png', 'tool', 'chrome')
    const list = h.list('t1')
    expect(list.map((c) => [c.name, c.relPath, c.source, c.caption])).toEqual([
      ['b.png', 'C:\\Temp\\b.png', 'tool', 'chrome'],
      ['a.png', 'out\\a.png', 'created', null]
    ])
    expect(list[0].id).toMatch(/^[0-9a-f]{20}$/)
    expect(onChange).toHaveBeenCalledWith('t1')
    expect(h.unseenCount('t1')).toBe(2)
  })

  it('re-adding a known path updates the card instead of duplicating it (case-insensitive)', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\proj')
    h.add('t1', 'D:\\proj\\plot.png', 'created', null)
    h.add('t1', 'D:\\proj\\other.png', 'created', null)
    h.add('t1', 'd:\\PROJ\\plot.png', 'created', null, undefined, true)
    const list = h.list('t1')
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'plot.png', version: 2, updated: true })
  })

  it('a re-add without a content change moves the card to the top but is not marked updated', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\proj')
    h.add('t1', 'D:\\proj\\plot.png', 'created', null)
    h.add('t1', 'D:\\proj\\other.png', 'created', null)
    h.add('t1', 'D:\\proj\\plot.png', 'read', 'looked at', 7)
    const list = h.list('t1')
    expect(list.map((c) => c.name)).toEqual(['plot.png', 'other.png'])
    expect(list[0]).toMatchObject({ version: 1, updated: false, source: 'read', caption: 'looked at', touchedAt: 7 })
  })

  it('a more explicit source wins and show_image sets the caption', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\proj')
    h.add('t1', 'D:\\proj\\plot.png', 'created', null)
    h.add('t1', 'D:\\proj\\plot.png', 'shown', 'Revenue chart')
    h.add('t1', 'D:\\proj\\plot.png', 'created', null)
    expect(h.list('t1')[0]).toMatchObject({ source: 'shown', caption: 'Revenue chart' })
  })

  it('keeps an explicit timestamp for history images', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\proj')
    h.add('t1', 'D:\\proj\\a.png', 'read', null, 42)
    expect(h.list('t1')[0].touchedAt).toBe(42)
  })

  it('marks deleted files and removes cards', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\proj')
    const c = h.add('t1', 'D:\\proj\\a.png', 'created', null)!
    h.markDeleted('t1', 'D:\\proj\\a.png')
    expect(h.list('t1')[0].deleted).toBe(true)
    expect(h.remove(c.id)?.path).toBe('D:\\proj\\a.png')
    expect(h.list('t1')).toEqual([])
    expect(h.get(c.id)).toBeNull()
  })

  it('trims to maxItems, dropping the oldest', () => {
    const { h } = hub(2)
    h.addTab('t1', 'D:\\p')
    for (const n of ['1', '2', '3']) h.add('t1', `D:\\p\\${n}.png`, 'created', null)
    expect(h.list('t1').map((c) => c.name)).toEqual(['3.png', '2.png'])
    expect(h.unseenCount('t1')).toBe(2)
  })

  it('markSeen clears the unseen counter once', () => {
    const { h, onChange } = hub()
    h.addTab('t1', 'D:\\p')
    h.add('t1', 'D:\\p\\a.png', 'created', null)
    onChange.mockClear()
    h.markSeen('t1')
    h.markSeen('t1')
    expect(h.unseenCount('t1')).toBe(0)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('a seen image reported again without a content change is not unseen again', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\p')
    h.add('t1', 'D:\\p\\a.png', 'shown', null)
    h.markSeen('t1')
    h.add('t1', 'D:\\p\\a.png', 'created', null) // the folder watcher reports the same file a moment later
    expect(h.unseenCount('t1')).toBe(0)
    h.add('t1', 'D:\\p\\a.png', 'created', null, undefined, true) // the file was rewritten
    expect(h.unseenCount('t1')).toBe(1)
  })

  it('the same path in two tabs gives two independent cards', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\same')
    h.addTab('t2', 'D:\\same')
    const a = h.add('t1', 'D:\\same\\x.png', 'shown', 'from t1')!
    const b = h.add('t2', 'D:\\same\\x.png', 'shown', 'from t2')!
    expect(a.id).not.toBe(b.id)
    expect(h.list('t1')[0].caption).toBe('from t1')
    expect(h.list('t2')[0].caption).toBe('from t2')
  })

  it('resolveTarget: known tab, else the active tab, else null', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\p')
    h.addTab('t2', 'D:\\p')
    expect(h.resolveTarget('t2', 't1')).toBe('t2')
    expect(h.resolveTarget('unknown', 't1')).toBe('t1')
    expect(h.resolveTarget(null, 't1')).toBe('t1')
    expect(h.resolveTarget(null, null)).toBeNull()
    expect(h.add('nope', 'D:\\a.png', 'created', null)).toBeNull()
  })

  it('notices and tab removal', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\p')
    h.setNotice('t1', 'watch off')
    expect(h.notice('t1')).toBe('watch off')
    h.removeTab('t1')
    expect(h.hasTab('t1')).toBe(false)
    expect(h.list('t1')).toEqual([])
  })
})

describe('helpers', () => {
  it('cardId depends on tab and normalized path', () => {
    expect(cardId('t1', 'D:\\a.png')).toBe(cardId('t1', 'd:\\A.PNG'))
    expect(cardId('t1', 'D:\\a.png')).not.toBe(cardId('t2', 'D:\\a.png'))
  })

  it('relPathOf only shortens paths inside cwd', () => {
    expect(relPathOf('D:\\proj', 'D:\\proj\\out\\a.png')).toBe('out\\a.png')
    expect(relPathOf('D:\\proj', 'D:\\other\\a.png')).toBe('D:\\other\\a.png')
    expect(relPathOf('D:\\proj', 'C:\\a.png')).toBe('C:\\a.png')
  })
})
