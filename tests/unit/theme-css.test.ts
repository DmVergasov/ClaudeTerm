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
})
