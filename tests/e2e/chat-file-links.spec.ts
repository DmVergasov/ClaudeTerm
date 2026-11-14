import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChatTab } from './chat-helpers'

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
