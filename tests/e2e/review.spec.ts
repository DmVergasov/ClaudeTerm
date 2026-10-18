import { expect, test, type Page } from '@playwright/test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { assistantLine, editResultLine } from '../fixtures/transcript'
import { FAKE_CLAUDE_SETTINGS, gitRepo, launchApp, launchClaudeTab, KEYS, KEY_LABELS } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

/** a Claude tab in a fresh repository whose session ClaudeTerm knows, with an empty transcript; `edit` changes files first */
async function reviewTab(edit?: (repo: string) => void) {
  const repo = gitRepo()
  edit?.(repo)
  const launched = await launchClaudeTab(FAKE_CLAUDE_SETTINGS, repo)
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, '')
  expect(await sendPipeMessage(launched.pipeName, { v: 1, type: 'session', tabId: launched.tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  return { ...launched, repo, transcriptPath, a: join(repo, 'a.ts') }
}
const upper = (repo: string): void => writeFileSync(join(repo, 'a.ts'), 'one\nTWO\nthree\n')
/** a transcript line written now: only an assistant entry newer than a dialog closes it */
const now = (line: string): string => JSON.stringify({ ...(JSON.parse(line) as object), timestamp: new Date().toISOString() })
const panel = (page: Page) => page.locator('#image-panel')
const changesTab = (page: Page) => page.locator('#tabbar .tab-changes-toggle')
const imagesTab = (page: Page) => page.locator('#tabbar .tab-images-toggle')
const panelTitle = (page: Page) => page.locator('.panel-title')
const file = (page: Page, rel: string) => page.locator(`.review-file[data-path="${rel}"]`)
const added = (page: Page, rel: string) => file(page, rel).locator('.review-line.add .review-code')

async function addComment(page: Page, rel: string, text: string): Promise<void> {
  const row = file(page, rel).locator('.review-line.add').first()
  await row.hover()
  await row.locator('.review-plus').click()
  await page.locator('.review-comment-input').fill(text)
  await page.locator('.review-btn.primary').click()
}

test('Ctrl+Shift+D opens Changes with the uncommitted diff; scopes switch', async () => {
  const { app, page } = await reviewTab(upper)
  await page.keyboard.press(KEYS.changes)
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect(changesTab(page)).toHaveClass(/active/)
  await expect(file(page, 'a.ts').locator('.review-status')).toHaveText('M')
  await expect(file(page, 'a.ts').locator('.review-line.del .review-code')).toHaveText('two')
  await expect(added(page, 'a.ts')).toHaveText('TWO')
  await expect(page.locator('.review-summary')).toHaveText('1 file · +1 −1')
  await page.locator('.review-seg-btn[data-scope="session"]').click()
  await expect(page.locator('.review-files .panel-empty')).toHaveText('No changes in this view')
  // the wait for the new view is over: nothing stays dimmed
  await expect(page.locator('.review-loading')).toHaveCount(0)
  await page.locator('.review-refresh').click()
  await expect(page.locator('.review-loading')).toHaveCount(0)
  await expect(page.locator('.review-seg-btn.active')).toHaveText('Session')
  await page.locator('.panel-hide').click()
  await expect(panel(page)).toHaveClass(/collapsed/)
  await app.close()
})

// also the spec's edit_before round trip: main replies only after it has read the file, so the baseline is the old text
test('Last turn and Session compare with the files before Claude changed them', async () => {
  const { app, page, tabId, pipeName, transcriptPath, repo, a } = await reviewTab()
  const turn = () => sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID, cwd: repo })
  const before = (toolUseId: string) => sendPipeMessage(pipeName, { v: 1, type: 'edit_before', tabId, sessionId: SID, toolUseId, path: a })
  expect(await turn()).toEqual({ ok: true })
  expect(await before('toolu_1')).toEqual({ ok: true })
  writeFileSync(a, 'one\ntwo\nthree\nfour\n')
  appendFileSync(transcriptPath, editResultLine({ toolUseId: 'toolu_1', filePath: a }) + '\n')
  await page.keyboard.press(KEYS.changes)
  await page.locator('.review-seg-btn[data-scope="last_turn"]').click()
  // Uncommitted would show 'four' too: the active button proves the view is Last turn
  await expect(page.locator('.review-seg-btn.active')).toHaveText('Last turn')
  await expect(added(page, 'a.ts')).toHaveText('four')
  expect(await turn()).toEqual({ ok: true })
  expect(await before('toolu_2')).toEqual({ ok: true })
  writeFileSync(a, 'zero\none\ntwo\nthree\nfour\n')
  appendFileSync(transcriptPath, editResultLine({ toolUseId: 'toolu_2', filePath: a }) + '\n')
  await expect(added(page, 'a.ts')).toHaveText('zero', { timeout: 10_000 })
  await page.locator('.review-seg-btn[data-scope="session"]').click()
  await expect(added(page, 'a.ts')).toHaveText(['zero', 'four'])
  await app.close()
})

test('Last turn leaves out the files git ignores and says how many', async () => {
  const { app, page, tabId, pipeName, repo, a } = await reviewTab((r) => {
    writeFileSync(join(r, '.gitignore'), 'dist/\n')
    mkdirSync(join(r, 'dist'))
  })
  const out = join(repo, 'dist', 'out.js')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID, cwd: repo })).toEqual({ ok: true })
  for (const [id, path] of [['toolu_1', a], ['toolu_2', out]] as const) {
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'edit_before', tabId, sessionId: SID, toolUseId: id, path })).toEqual({ ok: true })
  }
  writeFileSync(a, 'one\ntwo\nthree\nfour\n')
  writeFileSync(out, 'built\n')
  await page.keyboard.press(KEYS.changes)
  await page.locator('.review-seg-btn[data-scope="last_turn"]').click()
  await expect(page.locator('.review-seg-btn.active')).toHaveText('Last turn')
  await expect(added(page, 'a.ts')).toHaveText('four')
  await expect(page.locator('.review-file')).toHaveCount(1)
  await expect(page.locator('.review-summary')).toContainText('1 file · +1 −0 · 1 ignored')
  await expect(page.locator('.review-ignored')).toHaveAttribute('title', 'Files git ignores are hidden (review.hideIgnored)')
  await app.close()
})

test('Session shows only the files inside the tab folder and counts the rest', async () => {
  const { app, page, tabId, pipeName, repo, a } = await reviewTab((r) => {
    writeFileSync(join(r, '.gitignore'), 'dist/\n')
    mkdirSync(join(r, 'dist'))
  })
  const out = join(repo, 'dist', 'out.js')
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'ct-memory-')), 'note.md')
  writeFileSync(elsewhere, 'old\n')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID, cwd: repo })).toEqual({ ok: true })
  for (const [id, path] of [['toolu_1', a], ['toolu_2', elsewhere], ['toolu_3', out]] as const) {
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'edit_before', tabId, sessionId: SID, toolUseId: id, path })).toEqual({ ok: true })
  }
  writeFileSync(a, 'one\ntwo\nthree\nfour\n')
  writeFileSync(elsewhere, 'new\n')
  writeFileSync(out, 'built\n')
  await page.keyboard.press(KEYS.changes)
  await page.locator('.review-seg-btn[data-scope="session"]').click()
  await expect(page.locator('.review-seg-btn.active')).toHaveText('Session')
  await expect(added(page, 'a.ts')).toHaveText('four')
  await expect(page.locator('.review-file')).toHaveCount(1)
  await expect(page.locator('.review-summary')).toContainText('1 file · +1 −0 · 1 outside the folder · 1 ignored')
  await expect(page.locator('.review-summary .review-hidden-outside')).toHaveAttribute('title', `Files outside ${repo} are not shown:\n${elsewhere}`)
  await app.close()
})

test('Uncommitted stays in the tab folder repository after Claude cds into another one', async () => {
  const { app, page, tabId, pipeName, repo, a } = await reviewTab(upper)
  const other = gitRepo()
  writeFileSync(join(other, 'other.ts'), 'other\n')
  /** a turn Claude starts in `cwd` that changes a.ts; its end computes the view again */
  const turn = async (cwd: string, text: string): Promise<void> => {
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID, cwd })).toEqual({ ok: true })
    writeFileSync(a, text)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  }
  await page.keyboard.press(KEYS.changes)
  await turn(repo, 'one\nTWO\nthree\nFOUR\n')
  // the view computed after the first turn's change: no compute started before the next turn is left
  await expect(added(page, 'a.ts')).toHaveText(['TWO', 'FOUR'])
  // a Bash `cd` in the first turn left Claude in the other repository: the next prompt's hook reports that folder
  await turn(other, 'one\nTWO\nthree\nFOUR\nFIVE\n')
  await expect(added(page, 'a.ts')).toHaveText(['TWO', 'FOUR', 'FIVE'])
  await expect(page.locator('.review-file')).toHaveCount(1)
  await expect(page.locator('.status-changes')).toHaveAttribute('title', `Uncommitted changes in ${repo}`)
  await app.close()
})

test('Viewed folds a file until it changes again', async () => {
  const { app, page, a } = await reviewTab(upper)
  await page.keyboard.press(KEYS.changes)
  await expect(changesTab(page).locator('.badge')).toHaveText('1')
  await file(page, 'a.ts').locator('.review-viewed').check()
  await expect(file(page, 'a.ts')).toHaveClass(/viewed/)
  await expect(changesTab(page).locator('.badge')).toBeHidden()
  await expect(file(page, 'a.ts').locator('.review-line')).toHaveCount(0)
  writeFileSync(a, 'one\nTWO\nTHREE\n')
  await page.locator('.review-refresh').click()
  await expect(file(page, 'a.ts')).not.toHaveClass(/viewed/)
  await expect(changesTab(page).locator('.badge')).toHaveText('1')
  await app.close()
})

test('a comment is sent to Claude as one message followed by Enter', async () => {
  const { app, page, tabId } = await reviewTab(upper)
  await page.keyboard.press(KEYS.changes)
  await addComment(page, 'a.ts', 'Why upper case?')
  await expect(page.locator('.review-count')).toHaveText('1 comment')
  await page.locator('.review-send').click()
  await expect(page.locator('.review-count')).toHaveText('0 comments')
  // xterm's paste turns \n into \r, and wraps the text in bracketed-paste markers when the shell asked for them
  const sent = (await page.evaluate((id) => window.__ct!.ptyInput!(id), tabId)).replace(/\x1b\[20[01]~/g, '')
  expect(sent).toContain('Review comments on the changes (uncommitted):\r\r1. a.ts:2\r   > TWO\r   Why upper case?\r')
  await app.close()
})

test('Send waits while Claude shows a permission prompt, until the agent that asked goes on', async () => {
  const { app, page, tabId, pipeName, transcriptPath, a } = await reviewTab(upper)
  await page.keyboard.press(KEYS.changes)
  await addComment(page, 'a.ts', 'Hm')
  const sendBtn = page.locator('.review-send')
  await expect(sendBtn).toBeEnabled()
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(sendBtn).toBeDisabled()
  await expect(sendBtn).toHaveAttribute('title', "Answer Claude's prompt in the terminal first")
  // a subagent writes on: that does not answer the main conversation's prompt. Its edit, read in the same
  // poll right after its assistant entry, shows when the feed has read both
  writeFileSync(a, 'one\nTWO\nthree\nfive\n')
  const subagents = join(dirname(transcriptPath), SID, 'subagents')
  mkdirSync(subagents, { recursive: true })
  writeFileSync(join(subagents, 'agent-a9.jsonl'), [now(assistantLine('claude-opus-5-5')), editResultLine({ toolUseId: 'toolu_9', filePath: a })].join('\n') + '\n')
  await expect(added(page, 'a.ts')).toHaveText(['TWO', 'five'], { timeout: 10_000 })
  await expect(sendBtn).toBeDisabled()
  appendFileSync(transcriptPath, now(assistantLine('claude-opus-5-5')) + '\n')
  await expect(sendBtn).toBeEnabled({ timeout: 10_000 })
  await app.close()
})

test('a draft survives an update of the panel', async () => {
  const { app, page, tabId, pipeName, a } = await reviewTab(upper)
  await page.keyboard.press(KEYS.changes)
  const row = file(page, 'a.ts').locator('.review-line.add').first()
  await row.hover()
  await row.locator('.review-plus').click()
  await page.keyboard.type('abc')
  writeFileSync(a, 'one\nTWO\nthree\nfour\n')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  await expect(added(page, 'a.ts')).toHaveText(['TWO', 'four'])
  await page.keyboard.type('def')
  await expect(page.locator('.review-comment-input')).toHaveValue('abcdef')
  await app.close()
})

test('show_diff opens a request with a chip; the chip goes back to the scopes', async () => {
  const { app, page, tabId, pipeName, repo } = await reviewTab((r) => {
    upper(r)
    writeFileSync(join(r, 'b.ts'), 'b\n')
  })
  const msg = { v: 1 as const, type: 'show_diff' as const, tabId, cwd: repo, scope: null, from: 'HEAD', to: null, paths: [join(repo, 'a.ts')], title: null }
  expect(await sendPipeMessage(pipeName, msg)).toEqual({ ok: true, info: 'Opened 1 file (+1 −1) in the Changes panel.' })
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect(page.locator('.review-chip-text')).toHaveText('HEAD → working tree · a.ts')
  await expect(page.locator('.review-file')).toHaveCount(1)
  await page.locator('.review-chip-close').click()
  await expect(page.locator('.review-seg-btn.active')).toHaveText('Uncommitted')
  await expect(page.locator('.review-file')).toHaveCount(2)
  expect(await sendPipeMessage(pipeName, { ...msg, from: 'mastr' })).toEqual({ ok: false, error: 'unknown revision: mastr' })
  await app.close()
})

test('show_diff opens a file git ignores when its paths name it', async () => {
  const { app, page, tabId, pipeName, repo } = await reviewTab((r) => {
    mkdirSync(join(r, 'docs', 'plans'), { recursive: true })
    writeFileSync(join(r, '.gitignore'), 'docs/plans/\n')
    writeFileSync(join(r, 'docs', 'plans', 'plan.md'), '# Plan\nstep one\n')
  })
  const msg = { v: 1 as const, type: 'show_diff' as const, tabId, cwd: repo, scope: null, from: null, to: null, paths: [join(repo, 'docs', 'plans', 'plan.md')], title: null }
  expect(await sendPipeMessage(pipeName, msg)).toEqual({ ok: true, info: 'Opened 1 file (+2 −0) in the Changes panel.' })
  await expect(added(page, 'docs/plans/plan.md')).toHaveText(['# Plan', 'step one'])
  await app.close()
})

// no status message: the counter is not part of Claude's status line and shows before the first one
test('the status bar counter shows the uncommitted changes without a status line, and opens the panel', async () => {
  const { app, page } = await reviewTab(upper)
  const counter = page.locator('#statusbar .status-changes')
  await expect(counter).toHaveText('± 1 file +1 −1', { timeout: 10_000 })
  // the hidden panel keeps the update without building its rows; the badge follows it
  await expect(page.locator('.review-file')).toHaveCount(0)
  await expect(changesTab(page).locator('.badge')).toHaveText('1')
  await counter.click()
  await expect(changesTab(page)).toHaveClass(/active/)
  await expect(added(page, 'a.ts')).toHaveText('TWO')
  await app.close()
})

test('a shell tab has no Changes button', async () => {
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await page.keyboard.press(KEYS.images)
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect(changesTab(page)).toBeHidden()
  await page.keyboard.press(KEYS.changes)
  await expect(imagesTab(page)).toHaveClass(/active/)
  await app.close()
})

test('Changes and Images have their own buttons and replace each other', async () => {
  const { app, page, tabId } = await reviewTab(upper)
  await expect(changesTab(page)).toHaveAttribute('title', `Changes (${KEY_LABELS.changes})`)
  await changesTab(page).click()
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect(changesTab(page)).toHaveClass(/active/)
  await expect(imagesTab(page)).not.toHaveClass(/active/)
  await expect(panelTitle(page)).toHaveText('Changes')
  // no tab strip came back
  await expect(panel(page).locator('.panel-header button', { hasText: /Images|Changes/ })).toHaveCount(0)
  await changesTab(page).click()
  await expect(panel(page)).toHaveClass(/collapsed/)
  await expect(changesTab(page)).not.toHaveClass(/active/)
  await expect(imagesTab(page)).not.toHaveClass(/active/)
  await changesTab(page).click()
  await imagesTab(page).click()
  await expect(imagesTab(page)).toHaveClass(/active/)
  await expect(changesTab(page)).not.toHaveClass(/active/)
  await expect(panelTitle(page)).toHaveText('Images')
  await imagesTab(page).click()
  await expect(panel(page)).toHaveClass(/collapsed/)
  await expect(imagesTab(page)).not.toHaveClass(/active/)
  await expect(changesTab(page)).not.toHaveClass(/active/)
  // a shell tab has no Changes button; coming to the front while Changes is shown, it shows Images in its place
  await changesTab(page).click()
  await expect(panelTitle(page)).toHaveText('Changes')
  await page.keyboard.press(KEYS.newTab)
  await expect(changesTab(page)).toBeHidden()
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect(imagesTab(page)).toHaveClass(/active/)
  await expect(panelTitle(page)).toHaveText('Images')
  await page.locator(`[data-tab-id="${tabId}"]`).click()
  await expect(changesTab(page)).toBeVisible()
  await expect(changesTab(page)).not.toHaveClass(/active/)
  await app.close()
})

const findRow = (page: Page) => page.locator('.review-find')
const findInput = (page: Page) => page.locator('.review-find-input')
const findCount = (page: Page) => page.locator('.review-find-count')
const matches = (page: Page) => page.locator('.review-files .review-match')
const currentMark = (page: Page) => page.locator('.review-files .review-match.current')
const needles = (repo: string): void => {
  writeFileSync(join(repo, 'a.ts'), 'one\nNeedle two\nthree needle\n')
  writeFileSync(join(repo, 'b.ts'), 'a needle in b\n')
}
/** the panel has the focus after a click in its diff; Ctrl+F then opens the find row */
async function openFind(page: Page): Promise<void> {
  await page.keyboard.press(KEYS.changes)
  await expect(added(page, 'a.ts').first()).toBeVisible()
  await added(page, 'a.ts').first().click()
  await page.keyboard.press(KEYS.panelFind)
  await expect(findRow(page)).toBeVisible()
  await expect(findInput(page)).toBeFocused()
}

test('Ctrl+F in the Changes panel finds text in the diff, highlights it and steps through the matches', async () => {
  const { app, page } = await reviewTab(needles)
  await openFind(page)
  await expect(findInput(page)).toHaveAttribute('placeholder', 'Find in changes')
  await expect(findCount(page)).toHaveText('')
  await page.keyboard.type('NEEDLE')
  await expect(findCount(page)).toHaveText('1 / 3')
  await expect(matches(page)).toHaveCount(3)
  await expect(currentMark(page)).toHaveCount(1)
  await expect(currentMark(page)).toHaveText('Needle')
  await page.keyboard.press('Enter')
  await expect(findCount(page)).toHaveText('2 / 3')
  await expect(currentMark(page)).toHaveText('needle')
  await expect(file(page, 'a.ts').locator('.review-match.current')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(findCount(page)).toHaveText('3 / 3')
  await expect(file(page, 'b.ts').locator('.review-match.current')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(findCount(page)).toHaveText('1 / 3')
  await page.keyboard.press('Shift+Enter')
  await expect(findCount(page)).toHaveText('3 / 3')
  await page.locator('.review-find-prev').click()
  await expect(findCount(page)).toHaveText('2 / 3')
  await page.locator('.review-find-next').click()
  await expect(findCount(page)).toHaveText('3 / 3')
  await findInput(page).fill('zzz')
  await expect(findCount(page)).toHaveText('No results')
  await expect(matches(page)).toHaveCount(0)
  await app.close()
})

test('the find button in the panel header opens the find row; a file path matches too', async () => {
  const { app, page } = await reviewTab(needles)
  await page.keyboard.press(KEYS.changes)
  await expect(findRow(page)).toBeHidden()
  await expect(page.locator('.panel-tools .review-find-btn')).toHaveAttribute('title', `Find (${KEY_LABELS.panelFind})`)
  await page.locator('.review-find-btn').click()
  await expect(findInput(page)).toBeFocused()
  await page.keyboard.type('b.ts')
  await expect(findCount(page)).toHaveText('1 / 1')
  await expect(file(page, 'b.ts').locator('.review-file-head .review-match.current')).toHaveText('b.ts')
  await app.close()
})

test('going to a match in a folded file unfolds it', async () => {
  const { app, page } = await reviewTab(needles)
  await page.keyboard.press(KEYS.changes)
  await file(page, 'b.ts').locator('.review-viewed').check()
  await expect(file(page, 'b.ts').locator('.review-line')).toHaveCount(0)
  await file(page, 'a.ts').locator('.review-code').first().click()
  await page.keyboard.press(KEYS.panelFind)
  await page.keyboard.type('needle')
  await expect(findCount(page)).toHaveText('1 / 3')
  await expect(file(page, 'b.ts').locator('.review-line')).toHaveCount(0)
  await page.keyboard.press('Shift+Enter')
  await expect(findCount(page)).toHaveText('3 / 3')
  await expect(file(page, 'b.ts').locator('.review-line')).toHaveCount(1)
  await expect(file(page, 'b.ts').locator('.review-match.current')).toHaveCount(1)
  await app.close()
})

test('Esc closes the find row, removes the highlights and gives the focus back to the panel', async () => {
  const { app, page } = await reviewTab(needles)
  await openFind(page)
  await page.keyboard.type('needle')
  await expect(matches(page)).toHaveCount(3)
  await page.keyboard.press('Escape')
  await expect(findRow(page)).toBeHidden()
  await expect(matches(page)).toHaveCount(0)
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  expect(await page.evaluate(() => document.activeElement?.classList.contains('review-files'))).toBe(true)
  await page.keyboard.press(KEYS.panelFind)
  await expect(findInput(page)).toBeFocused()
  await app.close()
})

test('Ctrl+F in the terminal still goes to the terminal, not to the Changes panel', async () => {
  const { app, page, tabId } = await reviewTab(needles)
  await page.keyboard.press(KEYS.changes)
  await expect(added(page, 'a.ts').first()).toBeVisible()
  // the left of the terminal: a panel with no room to widen the window lies over its right
  await page.locator('.terminal-host:visible .xterm').click({ position: { x: 20, y: 20 } })
  // Ctrl+F is the terminal's on every system: on macOS the panel's key is ⌘F
  await page.keyboard.press('Control+KeyF')
  await expect(findRow(page)).toBeHidden()
  await expect.poll(() => page.evaluate((id) => window.__ct!.ptyInput!(id), tabId)).toContain('\x06')
  await app.close()
})

test('the find key in the Changes panel opens its find row only, not the terminal\'s find as well', async () => {
  const { app, page } = await reviewTab(needles)
  await openFind(page)
  await expect(page.locator('#search')).toBeHidden()
  await app.close()
})

test('the find row keeps its query and recomputes the matches when the view updates', async () => {
  const { app, page, tabId, pipeName, a } = await reviewTab(needles)
  await openFind(page)
  await page.keyboard.type('needle')
  await page.keyboard.press('Enter')
  await expect(findCount(page)).toHaveText('2 / 3')
  writeFileSync(a, 'one\nNeedle two\nthree needle\nfour needle\n')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  await expect(findCount(page)).toHaveText('2 / 4')
  await expect(matches(page)).toHaveCount(4)
  await expect(findInput(page)).toHaveValue('needle')
  writeFileSync(a, 'one\nnothing\n')
  writeFileSync(join(a, '..', 'b.ts'), 'b\n')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  await expect(findCount(page)).toHaveText('No results')
  await app.close()
})

/** a.ts with a long diff; `at` are the numbers of the lines that hold the word */
const longDiff = (at: number[]) => (repo: string): void => {
  const lines = Array.from({ length: 300 }, (_, i) => (at.includes(i + 1) ? `row ${i + 1} needle` : `row ${i + 1}`))
  writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n' + lines.join('\n') + '\n')
}

test('typing a query whose first match is in a folded file unfolds it and shows the match', async () => {
  const { app, page } = await reviewTab(needles)
  await page.keyboard.press(KEYS.changes)
  await file(page, 'a.ts').locator('.review-viewed').check()
  await expect(file(page, 'a.ts').locator('.review-line')).toHaveCount(0)
  await file(page, 'b.ts').locator('.review-code').first().click()
  await page.keyboard.press(KEYS.panelFind)
  await page.keyboard.type('needle')
  await expect(findCount(page)).toHaveText('1 / 3')
  await expect(file(page, 'a.ts').locator('.review-line').first()).toBeVisible()
  await expect(currentMark(page)).toHaveCount(1)
  await expect(currentMark(page)).toBeVisible()
  await expect(file(page, 'a.ts').locator('.review-match.current')).toHaveCount(1)
  await app.close()
})

test('after a click in a long diff the keyboard still scrolls it', async () => {
  const { app, page } = await reviewTab(longDiff([]))
  await page.keyboard.press(KEYS.changes)
  await expect(added(page, 'a.ts').nth(100)).toBeAttached()
  await added(page, 'a.ts').nth(5).click()
  await page.keyboard.press('PageDown')
  await expect.poll(() => page.locator('.review-files').evaluate((e) => e.scrollTop)).toBeGreaterThan(0)
  await app.close()
})

test('the current match is scrolled into view', async () => {
  const { app, page } = await reviewTab(longDiff([5, 280]))
  await openFind(page)
  await page.keyboard.type('needle')
  await expect(findCount(page)).toHaveText('1 / 2')
  await expect(currentMark(page)).toBeInViewport()
  await page.keyboard.press('Enter')
  await expect(findCount(page)).toHaveText('2 / 2')
  await expect(currentMark(page)).toBeInViewport()
  await page.keyboard.press('Shift+Enter')
  await expect(currentMark(page)).toBeInViewport()
  await app.close()
})

test('the current match is clamped to the last one when a view update removes the later matches', async () => {
  const { app, page, tabId, pipeName, a } = await reviewTab(needles)
  await openFind(page)
  await page.keyboard.type('needle')
  await page.keyboard.press('Shift+Enter')
  await expect(findCount(page)).toHaveText('3 / 3')
  writeFileSync(join(a, '..', 'b.ts'), 'b\n')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  await expect(findCount(page)).toHaveText('2 / 2')
  await expect(currentMark(page)).toHaveText('needle')
  await app.close()
})

test('app shortcuts still work while the find input has the focus', async () => {
  const { app, page } = await reviewTab(needles)
  await openFind(page)
  await page.keyboard.press(KEYS.changes)
  await expect(panel(page)).toHaveClass(/collapsed/)
  await app.close()
})

// the shell is stubbed in the main process: no Explorer window opens in a test
type App = Awaited<ReturnType<typeof reviewTab>>['app']
async function stubShell(app: App): Promise<void> {
  await app.evaluate(({ shell }) => {
    const calls: string[] = []
    ;(globalThis as Record<string, unknown>).__shellCalls = calls
    shell.showItemInFolder = (p: string) => { calls.push('show ' + p) }
    shell.openPath = (p: string) => { calls.push('open ' + p); return Promise.resolve('') }
  })
}
const shellCalls = (app: App) => app.evaluate(() => (globalThis as Record<string, unknown>).__shellCalls as string[])

test('the file menu offers Show in Explorer after Open in editor; it shows the file, and refuses a file the view does not show', async () => {
  const { app, page, a } = await reviewTab(upper)
  await stubShell(app)
  await page.keyboard.press(KEYS.changes)
  await file(page, 'a.ts').locator('.review-more').click()
  await expect(page.locator('.menu .menu-item')).toHaveText(['Open in editor', 'Show in Explorer', 'Copy path'])
  await page.locator('.menu .menu-item', { hasText: 'Show in Explorer' }).click()
  await expect.poll(() => shellCalls(app)).toEqual(['show ' + a])
  // a path outside the view is ignored
  await page.evaluate((p) => window.ct.revealFile(window.__ct!.activeTabId()!, p), join(dirname(a), 'other.ts'))
  await page.evaluate(() => window.ct.revealFile(window.__ct!.activeTabId()!, 'relative.ts'))
  await page.waitForTimeout(300)
  expect(await shellCalls(app)).toEqual(['show ' + a])
  await app.close()
})

function withTests(repo: string): void {
  upper(repo)
  mkdirSync(join(repo, 'tests'), { recursive: true })
  writeFileSync(join(repo, 'tests', 'a.test.ts'), 'it()\n')
  writeFileSync(join(repo, 'VehicleTest.cpp'), 'x\n')
  writeFileSync(join(repo, 'Contest.cpp'), 'y\n')
}

test('the Hide tests checkbox hides test files in the view, says how many, and shows them again', async () => {
  const { app, page, dataDir } = await reviewTab(withTests)
  await page.keyboard.press(KEYS.changes)
  const box = page.locator('.review-hide-tests input[type="checkbox"]')
  await expect(page.locator('.review-hide-tests')).toHaveText('Hide tests')
  await expect(page.locator('.review-hide-tests')).toHaveAttribute('title', 'Hide test files (review.hideTests)')
  // tests are shown by default
  await expect(box).not.toBeChecked()
  await expect(page.locator('.review-file')).toHaveCount(4)
  await expect(page.locator('.review-tests-hidden')).toHaveCount(0)
  await box.check()
  await expect(page.locator('.review-file')).toHaveCount(2)
  await expect(file(page, 'a.ts')).toHaveCount(1)
  await expect(file(page, 'Contest.cpp')).toHaveCount(1)
  await expect(file(page, 'tests/a.test.ts')).toHaveCount(0)
  await expect(box).toBeChecked()
  const hidden = page.locator('.review-tests-hidden')
  await expect(hidden).toHaveText('· 2 tests hidden')
  expect(await hidden.getAttribute('title')).toBe('Test files are hidden (review.hideTests):\nVehicleTest.cpp\ntests/a.test.ts')
  // saved like any other setting
  await expect.poll(() => (JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { review?: { hideTests?: boolean } }).review?.hideTests).toBe(true)
  // the status bar keeps counting all the changes
  await expect(page.locator('#statusbar .status-changes')).toContainText('4 files')
  await box.uncheck()
  await expect(page.locator('.review-file')).toHaveCount(4)
  await expect(page.locator('.review-tests-hidden')).toHaveCount(0)
  await app.close()
})

test('Hide tests applies to Last turn and Session, and to a show_diff request', async () => {
  const { app, page, tabId, pipeName, transcriptPath, repo, a } = await reviewTab()
  const spec = join(repo, 'tests', 'a.test.ts')
  mkdirSync(join(repo, 'tests'), { recursive: true })
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID, cwd: repo })).toEqual({ ok: true })
  for (const [id, path] of [['toolu_1', a], ['toolu_2', spec]] as const) {
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'edit_before', tabId, sessionId: SID, toolUseId: id, path })).toEqual({ ok: true })
  }
  writeFileSync(a, 'one\ntwo\nthree\nfour\n')
  writeFileSync(spec, 'it()\n')
  appendFileSync(transcriptPath, editResultLine({ toolUseId: 'toolu_1', filePath: a }) + '\n' + editResultLine({ toolUseId: 'toolu_2', filePath: spec }) + '\n')
  await page.keyboard.press(KEYS.changes)
  const box = page.locator('.review-hide-tests input[type="checkbox"]')
  await page.locator('.review-seg-btn[data-scope="session"]').click()
  await expect(page.locator('.review-file')).toHaveCount(2)
  await box.check()
  await expect(page.locator('.review-file')).toHaveCount(1)
  await expect(page.locator('.review-tests-hidden')).toHaveText('· 1 test hidden')
  await page.locator('.review-seg-btn[data-scope="last_turn"]').click()
  await expect(page.locator('.review-seg-btn.active')).toHaveText('Last turn')
  await expect(page.locator('.review-file')).toHaveCount(1)
  await expect(page.locator('.review-tests-hidden')).toHaveText('· 1 test hidden')
  const msg = { v: 1 as const, type: 'show_diff' as const, tabId, cwd: repo, scope: null, from: 'HEAD', to: null, paths: [], title: null }
  const r = await sendPipeMessage(pipeName, msg)
  expect(r).toMatchObject({ ok: true })
  expect((r as { info: string }).info).toContain('(1 test file is hidden: review.hideTests)')
  await expect(page.locator('.review-chip-text')).toHaveText('HEAD → working tree')
  await expect(page.locator('.review-tests-hidden')).toHaveText('· 1 test hidden')
  await app.close()
})

test('changing review.testPatterns while Hide tests is on changes the view without a refresh', async () => {
  const { app, page } = await reviewTab(withTests)
  await page.keyboard.press(KEYS.changes)
  await page.locator('.review-hide-tests input[type="checkbox"]').check()
  await expect(page.locator('.review-file')).toHaveCount(2)
  await expect(page.locator('.review-tests-hidden')).toHaveText('· 2 tests hidden')
  // only *.cpp files are tests now: the spec file comes back, the two .cpp files go
  await page.evaluate(() => window.ct.setSetting('review.testPatterns', ['*.cpp']))
  await expect(file(page, 'tests/a.test.ts')).toHaveCount(1)
  await expect(file(page, 'VehicleTest.cpp')).toHaveCount(0)
  await expect(file(page, 'Contest.cpp')).toHaveCount(0)
  await expect(page.locator('.review-tests-hidden')).toHaveText('· 2 tests hidden')
  await page.evaluate(() => window.ct.setSetting('review.testPatterns', []))
  await expect(page.locator('.review-file')).toHaveCount(4)
  await expect(page.locator('.review-tests-hidden')).toHaveCount(0)
  await app.close()
})

test('a refused save from the Hide tests checkbox puts the box back and says why', async () => {
  const { app, page, dataDir } = await reviewTab(withTests)
  await page.keyboard.press(KEYS.changes)
  writeFileSync(join(dataDir, 'settings.json'), '{ not json')
  const box = page.locator('.review-hide-tests input[type="checkbox"]')
  await box.click()
  await expect(page.locator('.toast', { hasText: "can't be used" })).toBeVisible()
  await expect(box).not.toBeChecked()
  await expect(page.locator('.review-file')).toHaveCount(4)
  await app.close()
})

/** a.ts changed and four new files in folders; hub.ts is long, so the files after it start below the fold */
function inFolders(repo: string): void {
  upper(repo)
  const added: [string, string][] = [
    ['src/main/hub.ts', Array.from({ length: 200 }, (_, i) => `hub line ${i}\n`).join('')],
    ['src/main/pipe.ts', 'pipe\n'],
    ['docs/guide.md', 'guide words\n'],
    ['top.ts', 'top\n']
  ]
  for (const [path, text] of added) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
}
const treeNames = (page: Page) => page.locator('.review-tree .review-tree-name')
const diffPaths = (page: Page) => page.locator('.review-file').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path))

test('the file tree lists the files by folder, the diffs follow its order, and a click on a folded file opens it', async () => {
  const { app, page } = await reviewTab(inFolders)
  await page.keyboard.press(KEYS.changes)
  await expect(treeNames(page)).toHaveText(['docs', 'guide.md', 'src/main', 'hub.ts', 'pipe.ts', 'a.ts', 'top.ts'])
  expect(await diffPaths(page)).toEqual(['docs/guide.md', 'src/main/hub.ts', 'src/main/pipe.ts', 'a.ts', 'top.ts'])
  await file(page, 'top.ts').locator('.review-file-head').click()
  await expect(file(page, 'top.ts').locator('.review-line')).toHaveCount(0)
  await page.locator('.review-files').evaluate((e) => { e.scrollTop = 0 })
  await expect(file(page, 'top.ts')).not.toBeInViewport()
  await page.locator('.review-tree-file[data-path="top.ts"]').click()
  await expect(added(page, 'top.ts')).toHaveText('top')
  await expect(file(page, 'top.ts')).toBeInViewport()
  // a folder folds in the tree only
  await page.locator('.review-tree-dir[data-path="src/main"]').click()
  await expect(treeNames(page)).toHaveText(['docs', 'guide.md', 'src/main', 'a.ts', 'top.ts'])
  await expect(page.locator('.review-file')).toHaveCount(5)
  await app.close()
})

test('the file filter narrows the tree and the diffs, Find looks in the files shown only, and Esc clears it', async () => {
  const { app, page } = await reviewTab(inFolders)
  await page.keyboard.press(KEYS.changes)
  const filter = page.locator('.review-tree-filter')
  await filter.fill('MAIN')
  await expect(treeNames(page)).toHaveText(['src/main', 'hub.ts', 'pipe.ts'])
  expect(await diffPaths(page)).toEqual(['src/main/hub.ts', 'src/main/pipe.ts'])
  await expect(page.locator('.review-summary')).toContainText('2 of 5 files')
  // "guide" is only in docs/guide.md, which the filter leaves out
  await page.locator('.review-find-btn').click()
  await page.locator('.review-find-input').fill('guide')
  await expect(page.locator('.review-find-count')).toHaveText('No results')
  await page.locator('.review-find-close').click()
  await filter.press('Escape')
  await expect(filter).toHaveValue('')
  await expect(page.locator('.review-file')).toHaveCount(5)
  await expect(page.locator('.review-summary')).toContainText(/^5 files/)
  await app.close()
})

test('Collapse all and Expand all fold and unfold every file shown', async () => {
  const { app, page } = await reviewTab(inFolders)
  await page.keyboard.press(KEYS.changes)
  await expect(page.locator('.review-hunk')).toHaveCount(5)
  await page.locator('.review-collapse-all').click()
  await expect(page.locator('.review-file')).toHaveCount(5)
  await expect(page.locator('.review-hunk')).toHaveCount(0)
  await page.locator('.review-expand-all').click()
  await expect(page.locator('.review-hunk')).toHaveCount(5)
  await app.close()
})

test('the tree button hides the file tree with its filter, and settings.json keeps it hidden', async () => {
  const { app, page, dataDir } = await reviewTab(inFolders)
  await page.keyboard.press(KEYS.changes)
  const saved = () => (JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { review?: { fileTree?: boolean } }).review?.fileTree
  await page.locator('.review-tree-filter').fill('main')
  await expect(page.locator('.review-file')).toHaveCount(2)
  await page.locator('.review-tree-btn').click()
  await expect(page.locator('.review-tree')).toBeHidden()
  // a hidden filter does not filter
  await expect(page.locator('.review-file')).toHaveCount(5)
  await expect.poll(saved).toBe(false)
  await page.locator('.review-tree-btn').click()
  await expect(page.locator('.review-tree')).toBeVisible()
  await expect(page.locator('.review-tree-filter')).toHaveValue('')
  await expect.poll(saved).toBe(true)
  await app.close()
})
