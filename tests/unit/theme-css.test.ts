import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(new URL(`../../src/renderer/${file}`, import.meta.url), 'utf8')
/** the custom properties colors.css defines: the palette */
const PALETTE = new Set([...read('colors.css').matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]!))

/** the colours a stylesheet writes out, comments left out, in the file's order */
function literals(file: string): string[] {
  return read(file).replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? []
}

/** the custom properties a stylesheet reads that are not the palette's: its own, set by the code or by its rules */
function ownVars(file: string): string[] {
  return [...new Set([...read(file).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!))].filter((v) => !PALETTE.has(v)).sort()
}

describe('the stylesheets follow the theme', () => {
  it('chat.css keeps only the colours no theme changes: shadows, tints of fixed hues, the key on the accent', () => {
    expect(literals('chat/chat.css')).toEqual(['#00000066', '#00000066', '#00000022', '#2EA04326', '#F8514926', '#E5B56755', '#E5B567AA', '#000000AA', '#D977571F'])
  })

  it('chat.css reads every other colour from the palette', () => {
    expect(ownVars('chat/chat.css')).toEqual(['--agent', '--bar-delay', '--chat-plan-max', '--heads-up', '--mono'])
  })

  it('styles.css keeps only the colours no theme changes: shadows, the lightbox, the document page, text and tints on fixed hues', () => {
    expect(literals('styles.css')).toEqual(['#0A0A0C', '#111', '#111', '#111', '#000a', '#000a', '#000a', '#0A0A0C', '#000a', '#0008', '#0A0A0C', '#fff', '#000d', '#B5B5BE', '#000a',
      '#000a', '#e06c75', '#0A0A0C', 'rgba(217, 119, 87, 0.14)', '#111', '#111', 'rgba(255, 155, 148, 0.7)',
      'rgba(217, 119, 87, 0.12)', 'rgba(229, 192, 123, 0.45)', 'rgba(229, 192, 123, 0.35)', '#111', '#111', '#0A0A0C', '#000a',
      '#000a', '#000a'])
  })

  it('styles.css reads every other colour from the palette', () => {
    expect(ownVars('styles.css')).toEqual(['--browser-panel-width', '--dc', '--dev', '--elapsed', '--fill', '--group-color', '--held-host', '--mail-line', '--meter', '--panel-cover', '--pulse-delay',
      '--row-pulse', '--slide-w', '--spin-delay', '--status', '--status-room', '--term-bg', '--used'])
  })

  it('settings.css keeps only the colours no theme changes: shadows, the accent and its hover, text and tints on fixed hues', () => {
    expect(literals('settings.css')).toEqual(['#0A0A0C', '#0A0A0C', 'rgba(217, 119, 87, 0.25)', '#0006', '#FFFFFF', 'rgba(217, 119, 87, 0.6)', 'rgba(217, 119, 87, 0.6)',
      '#0A0A0C', '#E08A6B', '#E08A6B', '#E5B5670F', '#E5B56755', '#000a', '#1A1A1A', '#E08A6B', '#E08A6B', '#000c', '#1A1A1A',
      '#D9775722', '#7FA7F544', '#7FA7F50D', '#E5B56755', '#E5B5670D', '#0008', '#E5B56722', '#F2867E22', '#1A1A1A', '#63C08F1A',
      '#63C08F66', '#63C08F44', '#63C08F0D', '#E5B56755', '#E5B5670D', '#D9775744'])
  })

  it('settings.css reads every other colour from the palette', () => {
    expect(ownVars('settings.css')).toEqual([])
  })

  it('mcp.css keeps only the colours no theme changes: text and tints on fixed hues, a shadow', () => {
    expect(literals('mcp/mcp.css')).toEqual(['#fff', '#F2867E33', '#F2867E0D', '#1A1A1A', '#E5B56755', '#E5B5670F', '#fff', '#000c', '#D9775722',
      '#63C08F44', '#63C08F0D', '#D977570F', '#7FA7F555', '#7FA7F50F'])
  })

  it('mcp.css reads every other colour from the palette', () => {
    expect(ownVars('mcp/mcp.css')).toEqual([])
  })
})
