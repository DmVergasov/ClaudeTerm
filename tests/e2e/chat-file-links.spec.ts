import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChatTab, sendMessage } from './chat-helpers'

/** a stand-in editor: each run appends `<file>\t<line>` as a line; the test never starts a real editor */
function standInEditor(): { command: string; runs(): string[][] } {
  const dir = mkdtempSync(join(tmpdir(), 'ct-editor-'))
  const script = join(dir, 'editor.js')
  const record = join(dir, 'runs.txt')
  writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(record)}, process.argv.slice(2).join('\\t') + '\\n')\n`)
  return {
    command: `node "${script}" {file} {line}`,
    runs: () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter((l) => l !== '').map((l) => l.split('\t')) : [])
  }
}

/** a work folder with source files and Markdown documents */
function project(): string {
  const work = mkdtempSync(join(tmpdir(), 'ct-links-'))
  for (const dir of ['src', 'docs', join('.superpowers', 'sdd')]) mkdirSync(join(work, dir), { recursive: true })
  writeFileSync(join(work, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(work, 'src', 'b.ts'), 'export const b = 2\n')
  writeFileSync(join(work, 'docs', 'spec.md'), '# Spec\n\nBody.\n')
  writeFileSync(join(work, '.superpowers', 'sdd', 'plan.md'), '# The plan\n\nSteps.\n')
  writeFileSync(join(work, 'notes.md'), '# Notes\n')
  return work
}

test('main answers the paths that are files of a local Claude tab, and opens only a file it answered', async () => {
  const editor = standInEditor()
  const work = project()
  const { app, page, tabId } = await launchChatTab({ turns: {} }, { work, review: { editor: editor.command } })
  try {
    const ask = (id: unknown, paths: unknown) => page.evaluate(({ id, paths }) => window.ct.chatFileLinks(id as string, paths as string[]), { id, paths })
    const open = (file: string, line: number | null) => page.evaluate(({ id, file, line }) => window.ct.chatOpenFile(id, file, line), { id: tabId, file, line })
    const answer = await ask(tabId, ['src/a.ts:12', 'docs/spec.md', 'missing/file.md', 'src'])
    expect(answer.map((l) => [l.path, l.kind, l.line])).toEqual([['src/a.ts:12', 'file', 12], ['docs/spec.md', 'doc', null]])
    expect(realpathSync.native(answer[0]!.file)).toBe(realpathSync.native(join(work, 'src', 'a.ts')))
    // what is not a local Claude tab's list of at most 200 paths is refused
    expect(await ask('no-such-tab', ['src/a.ts'])).toEqual([])
    expect(await ask(tabId, Array(201).fill('src/a.ts'))).toEqual([])
    expect(await ask(tabId, [42])).toEqual([])
    expect(await ask(tabId, 'src/a.ts')).toEqual([])
    // a file no answer named is not opened; one that was opens in the editor at its line
    await open(join(work, 'src', 'b.ts'), 3)
    await open(answer[0]!.file, 12)
    await expect.poll(() => editor.runs().length).toBe(1)
    await page.waitForTimeout(500)
    expect(editor.runs()).toEqual([[answer[0]!.file, '12']])
    // a document opens in the Docs panel
    await open(answer[1]!.file, null)
    await expect(page.locator('.panel-title')).toHaveText('Docs')
    await expect(page.locator('.doc-md h1')).toHaveText('Spec')
  } finally {
    await app.close()
  }
})

test('paths in an answer that are files are links: a document opens in Docs, another file in the editor at its line; a missing one stays text', async () => {
  const editor = standInEditor()
  const work = project()
  const { app, page } = await launchChatTab({ turns: { files: [{ text: 'Read .superpowers/sdd/plan.md, then `src/a.ts:12`, [the notes](notes.md) and missing/file.md.', chunks: 6, pace: 60 }] } }, { work, review: { editor: editor.command } })
  try {
    await sendMessage(page, 'files')
    const links = page.locator('.chat-text .chat-file-link')
    await expect(links).toHaveText(['.superpowers/sdd/plan.md', 'src/a.ts:12', 'the notes'])
    await expect(page.locator('.chat-text')).toContainText('missing/file.md')
    await expect(links.nth(0)).toHaveCSS('cursor', 'pointer')
    await expect(links.nth(0)).toHaveAttribute('title', /^Open .*plan\.md in Docs$/)
    await expect(links.nth(1)).toHaveAttribute('title', /^Open .*a\.ts:12 in the editor$/)
    await links.nth(0).click()
    await expect(page.locator('.panel-title')).toHaveText('Docs')
    await expect(page.locator('.doc-md h1')).toHaveText('The plan')
    await links.nth(1).click()
    await expect.poll(() => editor.runs().length).toBe(1)
    const [file, line] = editor.runs()[0]!
    expect(realpathSync.native(file!)).toBe(realpathSync.native(join(work, 'src', 'a.ts')))
    expect(line).toBe('12')
  } finally {
    await app.close()
  }
})

test('a path Claude names before the file is written becomes a link when the turn ends', async () => {
  const work = project()
  const { app, page, config } = await launchChatTab({ turns: { later: [{ text: 'I will write notes/later.md next.' }, { gate: 'write' }, { text: 'Written.' }] } }, { work })
  try {
    await sendMessage(page, 'later')
    // main was asked while the file is missing: the path stays text
    await expect(page.locator('.chat-text .chat-path[data-link="none"]')).toHaveText(['notes/later.md'])
    mkdirSync(join(work, 'notes'))
    writeFileSync(join(work, 'notes', 'later.md'), '# Later\n')
    writeFileSync(join(config, 'write'), '')
    await expect(page.locator('.chat-text', { hasText: 'Written.' })).toHaveCount(1)
    await expect(page.locator('.chat-text .chat-file-link')).toHaveText(['notes/later.md'])
  } finally {
    await app.close()
  }
})

test('an answer naming more paths than one request carries links them all', async () => {
  const work = project()
  mkdirSync(join(work, 'f'))
  const names = Array.from({ length: 205 }, (_, i) => `f/${i}.md`)
  for (const name of names) writeFileSync(join(work, name), '# x\n')
  const { app, page } = await launchChatTab({ turns: { many: [{ text: names.join(' ') }] } }, { work })
  try {
    await sendMessage(page, 'many')
    await expect(page.locator('.chat-text .chat-file-link')).toHaveCount(205)
  } finally {
    await app.close()
  }
})

test('a streamed answer asks main once it settles, not once per piece', async () => {
  const work = project()
  const { app, page } = await launchChatTab({ turns: { stream: [{ text: 'Read .superpowers/sdd/plan.md, then src/a.ts:12 and docs/spec.md for the change.', chunks: 12, pace: 40 }] } }, { work })
  try {
    // the registered handler is wrapped in place: it counts the calls and answers as before
    await app.evaluate(({ ipcMain }) => {
      const counter = globalThis as unknown as { fileLinkAsks: number }
      counter.fileLinkAsks = 0
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const original = handlers.get('chat:file-links')!
      handlers.set('chat:file-links', (...args: unknown[]) => {
        counter.fileLinkAsks++
        return original(...args)
      })
    })
    await sendMessage(page, 'stream')
    await expect(page.locator('.chat-text .chat-file-link')).toHaveCount(3)
    const asks = await app.evaluate(() => (globalThis as unknown as { fileLinkAsks: number }).fileLinkAsks)
    expect(asks).toBeGreaterThanOrEqual(1)
    expect(asks).toBeLessThan(4)
  } finally {
    await app.close()
  }
})
