import { describe, expect, it } from 'vitest'
import { extForMediaType, toolLabel, TranscriptParser } from '../../src/main/transcript-images'
import { PNG_B64, pastedLine, textLine, toolResultLine, toolUseLine } from '../fixtures/transcript'

const SHOT = 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\D--x\\sid\\scratchpad\\shot.png'

describe('TranscriptParser', () => {
  it('Read of an image file → kind read with the file path', () => {
    const p = new TranscriptParser({ subagent: false })
    expect(p.parseLine(toolUseLine('toolu_r1', 'Read', { file_path: SHOT }))).toEqual([])
    expect(p.parseLine(toolResultLine('toolu_r1', { mirror: true }))).toEqual([
      { kind: 'read', filePath: SHOT, data: PNG_B64, mediaType: 'image/png', caption: null, timestamp: Date.parse('2026-10-05T10:00:01.000Z') }
    ])
  })

  it('MCP screenshot → kind tool with a readable caption, not duplicated by toolUseResult', () => {
    const p = new TranscriptParser({ subagent: false })
    p.parseLine(toolUseLine('toolu_s1', 'mcp__claude-in-chrome__computer', { action: 'screenshot', tabId: 1 }))
    const out = p.parseLine(toolResultLine('toolu_s1', { mediaType: 'image/jpeg', withText: true, mirror: true }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'tool', filePath: null, mediaType: 'image/jpeg', caption: 'claude-in-chrome · computer (screenshot)' })
  })

  it('image pasted by the user → kind pasted', () => {
    const out = new TranscriptParser({ subagent: false }).parseLine(pastedLine())
    expect(out).toEqual([{ kind: 'pasted', filePath: null, data: PNG_B64, mediaType: 'image/png', caption: 'pasted by you', timestamp: Date.parse('2026-10-05T10:00:02.000Z') }])
  })

  it('subagent transcripts get a prefix', () => {
    const p = new TranscriptParser({ subagent: true })
    p.parseLine(toolUseLine('toolu_r1', 'Read', { file_path: SHOT }))
    p.parseLine(toolUseLine('toolu_s1', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }))
    expect(p.parseLine(toolResultLine('toolu_r1'))[0].caption).toBe('subagent · Read')
    expect(p.parseLine(toolResultLine('toolu_s1'))[0].caption).toBe('subagent · claude-in-chrome · computer (screenshot)')
  })

  it('tool_result without a known tool_use → kind tool without caption', () => {
    expect(new TranscriptParser({ subagent: false }).parseLine(toolResultLine('toolu_unknown'))[0]).toMatchObject({ kind: 'tool', caption: null })
  })

  it('ignores lines without images, broken JSON and non-base64 sources', () => {
    const p = new TranscriptParser({ subagent: false })
    expect(p.parseLine(textLine)).toEqual([])
    expect(p.parseLine('{"type":"user","message":')).toEqual([])
    expect(p.parseLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] } }))).toEqual([])
  })

  it('still finds images when the line has no message wrapper (format drift)', () => {
    const line = JSON.stringify({ type: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }] })
    expect(new TranscriptParser({ subagent: false }).parseLine(line)[0]).toMatchObject({ kind: 'pasted' })
  })
})

describe('helpers', () => {
  it('extForMediaType', () => {
    expect(extForMediaType('image/png')).toBe('png')
    expect(extForMediaType('IMAGE/JPEG')).toBe('jpg')
    expect(extForMediaType('image/webp')).toBe('webp')
    expect(extForMediaType('image/svg+xml')).toBeNull()
  })

  it('toolLabel', () => {
    expect(toolLabel('mcp__plugin_playwright__browser_take_screenshot', {})).toBe('plugin_playwright · browser_take_screenshot')
    expect(toolLabel('Bash', {})).toBe('Bash')
  })
})
