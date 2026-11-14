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
    expect(literals('styles.css')).toEqual(['#111', '#111', '#111', '#000a', '#000a', '#000a', '#000a', '#0008', '#fff', '#000d', '#000a', '#000a',
      '#e06c75', 'rgba(217, 119, 87, 0.14)', '#111', '#111', 'rgba(255, 155, 148, 0.7)', 'rgba(217, 119, 87, 0.12)', 'rgba(229, 192, 123, 0.45)',
      'rgba(229, 192, 123, 0.35)', '#111', '#111', '#000a', '#000a'])
  })

  it('styles.css reads every other colour from the palette', () => {
    expect(ownVars('styles.css')).toEqual(['--dc', '--elapsed', '--fill', '--group-color', '--held-host', '--meter', '--panel-cover', '--pulse-delay',
      '--row-pulse', '--slide-w', '--spin-delay', '--status', '--status-room', '--term-bg', '--used'])
  })
})
