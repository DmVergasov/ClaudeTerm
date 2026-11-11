import { describe, expect, it } from 'vitest'
import { graphiteEdit } from '../../src/main/look-migration'

describe('graphiteEdit', () => {
  it('an install still on Campbell moves to Graphite, every other key and the key order kept', () => {
    const out = graphiteEdit('{\n  "font": {"size": 12},\n  "theme": "Campbell",\n  "x": 1\n}')
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out!)
    expect(parsed).toEqual({ font: { size: 12 }, theme: 'Graphite', x: 1 })
    expect(Object.keys(parsed)).toEqual(['font', 'theme', 'x'])
  })

  it('another theme, a custom theme object, no theme, an unreadable file or no file change nothing', () => {
    expect(graphiteEdit('{ "theme": "One Half Dark" }')).toBeNull()
    expect(graphiteEdit('{ "theme": { "background": "#000000" } }')).toBeNull()
    expect(graphiteEdit('{}')).toBeNull()
    expect(graphiteEdit('{ not json')).toBeNull()
    expect(graphiteEdit(null)).toBeNull()
  })
})
