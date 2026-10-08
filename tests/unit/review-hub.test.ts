import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditLedger } from '../../src/main/edit-ledger'
import type { DiffInput } from '../../src/main/review-diff'
import { ReviewHub, TOO_MANY_NOTICE, type ReviewRequest } from '../../src/main/review-hub'
import type { Inputs, ReviewSources, TranscriptLog } from '../../src/main/review-sources'
import { IN_DIALOG, NOT_RUNNING, type ReviewUpdate } from '../../src/shared/review'

const ROOT = process.platform === 'win32' ? 'D:\\repo' : '/repo'
const TAB = 'tab-1'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const input = (rel: string, before: string | null, after: string | null): DiffInput => ({
  path: join(ROOT, rel), relPath: rel, forced: false,
  before: before === null ? { kind: 'absent' } : { kind: 'data', data: Buffer.from(before) },
  after: after === null ? { kind: 'absent' } : { kind: 'data', data: Buffer.from(after) }
})
const result = (...inputs: DiffInput[]): Inputs => ({ inputs, tooMany: false })

function setup(o: Partial<ReviewSources> = {}, active: string | null = TAB, now?: () => number, hideIgnored = false) {
  const published: ReviewUpdate[] = []
  const errors: string[] = []
  const git = vi.fn(async () => result(input('a.ts', 'a\n', 'b\n')))
  const ledger = vi.fn(() => result(input('s.ts', 'x\n', 'y\n')))
  const ignored = vi.fn(async (_root: string, _paths: string[]) => [] as string[])
  const totals = vi.fn(async () => ({ files: 7, additions: 70, deletions: 3 }))
  const sources: ReviewSources = {
    root: async () => ({ root: ROOT }),
    verify: async () => {},
    head: async () => 'HEAD',
    git,
    ledger,
    totals,
    read: () => ({ kind: 'data', data: Buffer.from('before\n') }),
    ledgerPaths: () => [],
    ignored,
    ...o
  }
  const dir = mkdtempSync(join(tmpdir(), 'ct-hub-'))
  let activeId = active
  const hub = new ReviewHub({
    sources,
    ledgerFor: (sid) => new EditLedger({ dir: join(dir, sid), now: () => 1, onError: () => {} }),
    activeTabId: () => activeId,
    publish: (u) => published.push(u),
    onError: (m) => errors.push(m),
    hideIgnored: () => hideIgnored,
    now
  })
  hub.addTab(TAB, ROOT, true)
  return { hub, published, errors, git, ledger, totals, ignored, setActive: (id: string | null) => { activeId = id }, last: () => published[published.length - 1]! }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ReviewHub views', () => {
  it('starts on Uncommitted in a repository and counts the changes', async () => {
    const { hub, last } = setup()
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ view: { kind: 'scope', scope: 'uncommitted' }, label: 'uncommitted', uncommitted: { available: true }, additions: 1, deletions: 1, unviewed: 1 })
    expect(last().counter).toEqual({ files: 1, additions: 1, deletions: 1, title: `Uncommitted changes in ${ROOT}` })
  })

  it('starts on Session outside a repository and says why Uncommitted is off', async () => {
    const { hub, last, git } = setup({ root: async () => ({ root: null, problem: 'Not a git repository' }) })
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ view: { kind: 'scope', scope: 'session' }, uncommitted: { available: false, reason: 'Not a git repository' } })
    expect(last().counter?.title).toBe("Claude's edits in this session")
    expect(git).not.toHaveBeenCalled()
  })

  it('computes only the tab in front; another tab waits until it is activated', async () => {
    const { hub, published, setActive } = setup()
    setActive('other')
    hub.trigger(TAB)
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toHaveLength(0)
    setActive(TAB)
    hub.activated(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toHaveLength(1)
  })

  it('debounces triggers by 300 ms', async () => {
    const { hub, git } = setup()
    hub.trigger(TAB)
    hub.trigger(TAB)
    await vi.advanceTimersByTimeAsync(200)
    hub.trigger(TAB)
    await vi.advanceTimersByTimeAsync(299)
    expect(git).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(git).toHaveBeenCalledTimes(1)
  })

  it('a trigger during a compute runs it again', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const git = vi.fn(async () => { await gate; return result(input('a.ts', 'a\n', 'b\n')) })
    const { hub, published } = setup({ git })
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(git).toHaveBeenCalledTimes(2)
    expect(published).toHaveLength(2)
  })

  it('a scope change during a compute discards the stale result', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const git = vi.fn(async () => { await gate; return result(input('a.ts', 'a\n', 'b\n')) })
    const { hub, published } = setup({ git })
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    hub.setScope(TAB, 'session')
    release()
    await vi.advanceTimersByTimeAsync(0)
    // the compute that started on Uncommitted publishes nothing, and no Session update carries its files
    expect(published.length).toBeGreaterThan(0)
    expect(published.map((u) => u.label)).not.toContain('uncommitted')
    expect(published.filter((u) => u.label === 'session').flatMap((u) => u.files.map((f) => f.relPath))).not.toContain('a.ts')
    expect(published[published.length - 1]!.label).toBe('session')
  })

  it('computes again when the tab comes to the front, even with nothing new', async () => {
    const { hub, published, git } = setup()
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(git).toHaveBeenCalledTimes(1)
    // files may have changed outside Claude meanwhile: activation always computes
    hub.activated(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(git).toHaveBeenCalledTimes(2)
    expect(published).toHaveLength(2)
  })

  it('keeps a Viewed mark while the file stays the same', async () => {
    const files = { after: 'b\n' }
    const { hub, last } = setup({ git: async () => result(input('a.ts', 'a\n', files.after)) })
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    const f = last().files[0]!
    hub.setViewed(TAB, f.path, f.hash, true)
    expect(last()).toMatchObject({ unviewed: 0, files: [{ viewed: true }] })
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last().files[0]!.viewed).toBe(true)
    files.after = 'c\n'
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ unviewed: 1, files: [{ viewed: false }] })
  })

  it('counts Uncommitted with git\'s numstat while the panel shows another scope, without building it', async () => {
    const { hub, last, git, totals } = setup()
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(totals).not.toHaveBeenCalled()
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(0)
    expect(git).toHaveBeenCalledTimes(1)
    expect(totals).toHaveBeenCalledWith(ROOT)
    expect(last()).toMatchObject({ label: 'session', counter: { files: 7, additions: 70, deletions: 3, title: `Uncommitted changes in ${ROOT}` } })
    // a failed count leaves the counter as it was
    totals.mockRejectedValueOnce(new Error('git diff failed'))
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last().counter).toMatchObject({ files: 7 })
  })

  it('stops diffing a view after 1.5 s and says the view is too big', async () => {
    let t = 0
    // every file takes a second to diff
    const three = async () => result(input('a.ts', 'a\n', 'b\n'), input('b.ts', 'a\n', 'b\n'), input('c.ts', 'a\n', 'b\n'))
    const { hub, last } = setup({ git: three }, TAB, () => (t += 1000))
    hub.refresh(TAB)
    // the build yields to the event loop between files (setImmediate): fake timers run one of those a millisecond
    await vi.advanceTimersByTimeAsync(10)
    expect(last().notice).toBe(TOO_MANY_NOTICE)
    expect(last().files.map((f) => f.note)).toEqual([null, null, 'too-many'])
  })

  it('opens in an editor only files the tab\'s view shows, a show_diff view too', async () => {
    const { hub } = setup()
    expect(hub.hasFile(TAB, join(ROOT, 'a.ts'))).toBe(false)
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(hub.hasFile(TAB, join(ROOT, 'a.ts'))).toBe(true)
    expect(hub.hasFile(TAB, join(ROOT, 'deploy.bat'))).toBe(false)
    expect(hub.hasFile('other', join(ROOT, 'a.ts'))).toBe(false)
    if (process.platform === 'win32') expect(hub.hasFile(TAB, join(ROOT, 'A.TS'))).toBe(true)
    await hub.showRequest(TAB, { cwd: ROOT, scope: 'session', from: null, to: null, paths: [], title: null })
    expect(hub.hasFile(TAB, join(ROOT, 's.ts'))).toBe(true)
    expect(hub.hasFile(TAB, join(ROOT, 'a.ts'))).toBe(false)
  })
})

describe('ReviewHub hideIgnored', () => {
  const dist = input('dist/x.js', 'a\n', 'b\n')
  const src = input('src/a.ts', 'a\n', 'b\n')
  const sources = (): Partial<ReviewSources> => ({
    ledgerPaths: () => [dist.path, src.path],
    ledger: vi.fn((_l, _g, _s, _b, _f, exclude) => result(...[dist, src].filter((i) => !exclude(i.path))))
  })
  const hitDist = async (_root: string, paths: string[]): Promise<string[]> => paths.filter((p) => p === dist.path)

  it('hides what git ignores in Session and says how many', async () => {
    const { hub, last, ignored } = setup(sources(), TAB, undefined, true)
    ignored.mockImplementation(hitDist)
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(10)
    expect(last().files.map((f) => f.relPath)).toEqual(['src/a.ts'])
    expect(last().ignored).toBe(1)
    expect(ignored).toHaveBeenCalledWith(ROOT, [dist.path, src.path])
  })

  it('asks git about the repository root, not the tab folder', async () => {
    const inSub = [input('sub/d/x.js', 'a\n', 'b\n'), input('sub/a.ts', 'a\n', 'b\n')]
    const { hub, ignored } = setup({ ...sources(), ledgerPaths: () => inSub.map((i) => i.path), ledger: () => result(inSub[1]!), root: async () => ({ root: ROOT }) }, TAB, undefined, true)
    hub.addTab('sub', join(ROOT, 'sub'), true)
    await hub.showRequest('sub', { cwd: join(ROOT, 'sub'), scope: 'session', from: null, to: null, paths: [], title: null })
    expect(ignored).toHaveBeenCalledWith(ROOT, inSub.map((i) => i.path))
  })

  it('hides them in Last turn and in a show_diff scope view, counting only what its paths keep', async () => {
    const { hub, last, ignored } = setup(sources(), TAB, undefined, true)
    ignored.mockImplementation(hitDist)
    hub.setScope(TAB, 'last_turn')
    await vi.advanceTimersByTimeAsync(10)
    expect(last()).toMatchObject({ ignored: 1, files: [{ relPath: 'src/a.ts' }] })
    const all = await hub.showRequest(TAB, { cwd: ROOT, scope: 'session', from: null, to: null, paths: [], title: null })
    expect(all.ok).toBe(true)
    expect(last()).toMatchObject({ ignored: 1, files: [{ relPath: 'src/a.ts' }] })
    await hub.showRequest(TAB, { cwd: ROOT, scope: 'session', from: null, to: null, paths: [join(ROOT, 'src')], title: null })
    expect(last()).toMatchObject({ ignored: 0, files: [{ relPath: 'src/a.ts' }] })
  })

  it('tells Claude in show_diff that files were hidden', async () => {
    const { hub, ignored } = setup(sources(), TAB, undefined, true)
    ignored.mockImplementation(hitDist)
    const req = (paths: string[]) => ({ cwd: ROOT, scope: 'session' as const, from: null, to: null, paths, title: null })
    expect(await hub.showRequest(TAB, req([]))).toEqual({ ok: true, info: 'Opened 1 file (+1 −1) in the Changes panel. (1 file git ignores is hidden: review.hideIgnored)' })
    expect(await hub.showRequest(TAB, req([dist.path]))).toEqual({ ok: false, error: `nothing in the view for paths: ${dist.path} (1 file git ignores is hidden: review.hideIgnored)` })
  })

  it('a git-range request is not filtered and makes no check', async () => {
    const { hub, last, ignored } = setup(sources(), TAB, undefined, true)
    await hub.showRequest(TAB, { cwd: ROOT, scope: null, from: 'HEAD~1', to: null, paths: [], title: null })
    expect(last().ignored).toBe(0)
    expect(ignored).not.toHaveBeenCalled()
  })

  it('matches the paths git reports with the ones of the view by pathKey (case on Windows)', async () => {
    const { hub, last, ignored } = setup(sources(), TAB, undefined, true)
    ignored.mockImplementation(async () => [process.platform === 'win32' ? dist.path.toUpperCase() : dist.path])
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(10)
    expect(last().files.map((f) => f.relPath)).toEqual(['src/a.ts'])
  })

  it('shows everything when the setting is off', async () => {
    const { hub, last, ignored } = setup(sources(), TAB, undefined, false)
    ignored.mockImplementation(hitDist)
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(10)
    expect(last().files.map((f) => f.relPath)).toEqual(['dist/x.js', 'src/a.ts'])
    expect(last().ignored).toBe(0)
    expect(ignored).not.toHaveBeenCalled()
  })

  it('shows everything and reports the error when the check fails', async () => {
    const { hub, last, errors, ignored } = setup(sources(), TAB, undefined, true)
    ignored.mockRejectedValue(new Error('git was not found'))
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(10)
    expect(last().files.map((f) => f.relPath)).toEqual(['dist/x.js', 'src/a.ts'])
    expect(last().ignored).toBe(0)
    expect(errors).toEqual(['review: git was not found'])
  })

  it('does not check outside a repository', async () => {
    const { hub, last, ignored } = setup({ ...sources(), root: async () => ({ root: null, problem: 'Not a git repository' }) }, TAB, undefined, true)
    ignored.mockImplementation(hitDist)
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(10)
    expect(last().files.map((f) => f.relPath)).toEqual(['dist/x.js', 'src/a.ts'])
    expect(last().ignored).toBe(0)
    expect(ignored).not.toHaveBeenCalled()
  })

  it('leaves Uncommitted alone', async () => {
    const { hub, last, ignored } = setup(sources(), TAB, undefined, true)
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(10)
    expect(last()).toMatchObject({ label: 'uncommitted', ignored: 0 })
    expect(ignored).not.toHaveBeenCalled()
  })
})

describe('ReviewHub outside the folder', () => {
  const win = process.platform === 'win32'
  const ELSEWHERE = win ? 'C:\\Users\\me\\.claude\\projects\\p\\memory' : '/home/me/.claude/projects/p/memory'
  const src = input('src/a.ts', 'a\n', 'b\n')
  const mem = { ...input('x.md', 'a\n', 'b\n'), path: join(ELSEWHERE, 'x.md'), relPath: join(ELSEWHERE, 'x.md') }
  const sources = (all: DiffInput[] = [src, mem]): Partial<ReviewSources> => ({
    ledgerPaths: () => all.map((i) => i.path),
    ledger: vi.fn((_l, _g, _s, _b, _f, exclude) => result(...all.filter((i) => !exclude(i.path))))
  })
  const req = (o: Partial<ReviewRequest> = {}): ReviewRequest => ({ cwd: ROOT, scope: 'session', from: null, to: null, paths: [], title: null, ...o })

  it('Session lists only the files inside the tab folder and reports the rest', async () => {
    const { hub, last, ignored } = setup(sources(), TAB, undefined, true)
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(10)
    expect(last().files.map((f) => f.relPath)).toEqual(['src/a.ts'])
    expect(last()).toMatchObject({ outside: 1, outsideSample: [mem.path] })
    // the outside file is never sent to git
    expect(ignored).toHaveBeenCalledWith(ROOT, [src.path])
  })

  it('never asks the source to read an outside file', async () => {
    const o = sources()
    const { hub } = setup(o, TAB, undefined, false)
    hub.setScope(TAB, 'last_turn')
    await vi.advanceTimersByTimeAsync(10)
    const exclude = (o.ledger as ReturnType<typeof vi.fn>).mock.calls[0]![5] as (p: string) => boolean
    expect(exclude(mem.path)).toBe(true)
    expect(exclude(src.path)).toBe(false)
  })

  it('a case and separator variant of the folder is still the folder', async () => {
    const { hub, last } = setup(sources())
    const variant = win ? 'D:\\REPO\\' : '/repo/'
    hub.addTab('v', variant, true)
    await hub.showRequest('v', req())
    expect(last()).toMatchObject({ files: [{ relPath: 'src/a.ts' }], outside: 1 })
    if (win) {
      hub.addTab('drive', 'C:\\', true)
      await hub.showRequest('drive', req({ cwd: 'C:\\' }))
      expect(last()).toMatchObject({ files: [{ relPath: mem.relPath }], outside: 1 })
    }
  })

  it('Uncommitted and a git range leave everything in and report none outside', async () => {
    const { hub, last } = setup(sources())
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(10)
    expect(last()).toMatchObject({ label: 'uncommitted', outside: 0, outsideSample: [] })
    await hub.showRequest(TAB, req({ scope: null, from: 'HEAD~1' }))
    expect(last()).toMatchObject({ outside: 0, outsideSample: [] })
  })

  it('the folder is the one the tab was opened in, even after Claude moves to another', async () => {
    const { hub, last } = setup(sources())
    hub.turn(TAB, SID, join(ROOT, 'sub'))
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(10)
    expect(last()).toMatchObject({ files: [{ relPath: 'src/a.ts' }], outside: 1, folder: ROOT })
  })

  it('Uncommitted lists a file outside the tab folder when the repository is above it', async () => {
    const { hub, last } = setup(sources())
    hub.addTab('sub', join(ROOT, 'sub'), true)
    await hub.showRequest('sub', req({ scope: 'uncommitted' }))
    expect(last()).toMatchObject({ files: [{ relPath: 'a.ts' }], outside: 0, outsideSample: [] })
  })

  it('the sample holds at most 10 sorted paths while the count is the whole', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...mem, path: join(ELSEWHERE, `f${String(11 - i).padStart(2, '0')}.md`) }))
    const { hub, last } = setup(sources([src, ...many]))
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(10)
    const u = last()
    expect(u.outside).toBe(12)
    expect(u.outsideSample).toEqual(many.map((i) => i.path).sort().slice(0, 10))
  })

  it('counts only what the show_diff paths keep', async () => {
    const { hub, last } = setup(sources())
    await hub.showRequest(TAB, req({ paths: [join(ROOT, 'src')] }))
    expect(last()).toMatchObject({ outside: 0, files: [{ relPath: 'src/a.ts' }] })
  })

  it('tells Claude in show_diff that files were left out', async () => {
    const { hub } = setup(sources())
    expect(await hub.showRequest(TAB, req())).toEqual({ ok: true, info: 'Opened 1 file (+1 −1) in the Changes panel. (1 file outside the session folder is not shown)' })
    expect(await hub.showRequest(TAB, req({ paths: [mem.path] }))).toEqual({ ok: false, error: `nothing in the view for paths: ${mem.path} (1 file outside the session folder is not shown)` })
    const { hub: h2 } = setup(sources([mem, { ...mem, path: join(ELSEWHERE, 'y.md') }]))
    expect(await h2.showRequest(TAB, req())).toEqual({ ok: true, info: 'No changes in this view. (2 files outside the session folder are not shown)' })
  })

  it('both notes appear when files are ignored and outside', async () => {
    const dist = input('dist/x.js', 'a\n', 'b\n')
    const { hub, ignored } = setup(sources([src, dist, mem]), TAB, undefined, true)
    ignored.mockImplementation(async (_r, paths) => paths.filter((p) => p === dist.path))
    const r = await hub.showRequest(TAB, req())
    expect(r).toEqual({ ok: true, info: 'Opened 1 file (+1 −1) in the Changes panel. (1 file git ignores is hidden: review.hideIgnored) (1 file outside the session folder is not shown)' })
  })

  it('the status bar counter outside a repository follows the same rule', async () => {
    const { hub, last } = setup({ ...sources(), root: async () => ({ root: null, problem: 'Not a git repository' }) })
    hub.setScope(TAB, 'last_turn')
    await vi.advanceTimersByTimeAsync(10)
    expect(last().counter).toEqual({ files: 1, additions: 1, deletions: 1, title: "Claude's edits in this session" })
  })
})

describe('ReviewHub show_diff', () => {
  const req = (o: Partial<ReviewRequest> = {}): ReviewRequest => ({ cwd: ROOT, scope: null, from: 'HEAD~3', to: null, paths: [], title: null, ...o })

  it('opens the request with a chip label and asks the panel to show itself', async () => {
    const { hub, last, git } = setup()
    const r = await hub.showRequest(TAB, req({ paths: [join(ROOT, 'src')] }))
    expect(r).toEqual({ ok: true, info: 'Opened 1 file (+1 −1) in the Changes panel.' })
    expect(git.mock.calls[0]!.slice(0, 4)).toEqual([ROOT, 'HEAD~3', null, [join(ROOT, 'src')]])
    expect(last()).toMatchObject({ view: { kind: 'request' }, label: 'HEAD~3 → working tree · src', reveal: true })
    hub.clearRequest(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ view: { kind: 'scope', scope: 'uncommitted' }, reveal: false })
  })

  it('uses the title and reports an empty view', async () => {
    const { hub, last } = setup({ git: async () => result() })
    expect(await hub.showRequest(TAB, req({ title: 'Auth refactor' }))).toEqual({ ok: true, info: 'No changes in this view.' })
    expect(last().label).toBe('Auth refactor')
  })

  it('refuses outside a Claude tab, outside git, a bad revision and empty paths', async () => {
    const { hub } = setup()
    expect(await hub.showRequest(null, req())).toEqual({ ok: false, error: 'show_diff works only in a ClaudeTerm Claude tab' })
    hub.addTab('shell', ROOT, false)
    expect(await hub.showRequest('shell', req())).toEqual({ ok: false, error: 'show_diff works only in a ClaudeTerm Claude tab' })
    const nogit = setup({ root: async () => ({ root: null, problem: 'Not a git repository' }) })
    expect(await nogit.hub.showRequest(TAB, req())).toEqual({ ok: false, error: `not a git repository: ${ROOT}` })
    const badref = setup({ verify: async (_r, ref) => { throw new Error(`unknown revision: ${ref}`) } })
    expect(await badref.hub.showRequest(TAB, req({ from: 'mastr' }))).toEqual({ ok: false, error: 'unknown revision: mastr' })
    const empty = setup({ git: async () => result() })
    expect(await empty.hub.showRequest(TAB, req({ paths: [join(ROOT, 'nope')] }))).toEqual({ ok: false, error: `nothing in the view for paths: ${join(ROOT, 'nope')}` })
  })

  it('a scope request with paths filters Claude\'s edits', async () => {
    const { hub, last } = setup({ ledger: () => result(input('src/a.ts', 'a\n', 'b\n'), input('docs/b.md', 'a\n', 'b\n')) })
    await hub.showRequest(TAB, req({ from: null, scope: 'session', paths: [join(ROOT, 'src')] }))
    expect(last().files.map((f) => f.relPath)).toEqual(['src/a.ts'])
    expect(last().label).toBe('session · src')
  })
})

describe('ReviewHub Send guard', () => {
  // an assistant entry written after the dialog opened (fake timers freeze Date.now())
  const later = (): number => Date.now() + 1000
  it('blocks Send until Claude runs, during a dialog of the same agent, and after the session ends', async () => {
    const { hub } = setup()
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: NOT_RUNNING })
    hub.sessionStarted(TAB, SID, 'startup')
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    hub.dialogOpened(TAB, 'a1')
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.assistantEntry(TAB, null, later())
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.assistantEntry(TAB, 'a1', later())
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    hub.dialogOpened(TAB, null)
    hub.turnEnded(TAB)
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    hub.sessionEnded(TAB, SID)
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: NOT_RUNNING })
  })

  it('keeps Send blocked while any agent has a dialog open; Stop answers only the main conversation\'s', async () => {
    const { hub } = setup()
    hub.sessionStarted(TAB, SID, 'startup')
    hub.dialogOpened(TAB, 'a1')
    hub.dialogOpened(TAB, 'a2')
    hub.assistantEntry(TAB, 'a2', later())
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.assistantEntry(TAB, 'a1', later())
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    // a background subagent's dialog outlives the main conversation's Stop
    hub.dialogOpened(TAB, null)
    hub.dialogOpened(TAB, 'a1')
    hub.turnEnded(TAB)
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.assistantEntry(TAB, 'a1', later())
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    // the end of the session closes every dialog
    hub.dialogOpened(TAB, 'a2')
    hub.sessionEnded(TAB, SID)
    hub.sessionStarted(TAB, SID, 'startup')
    expect(hub.canSend(TAB)).toEqual({ ok: true })
  })

  it('ignores the end of a session the tab has already left', async () => {
    const NEXT = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'
    const { hub } = setup()
    hub.sessionStarted(TAB, SID, 'startup')
    hub.sessionStarted(TAB, NEXT, 'startup')
    // /clear: the old session's SessionEnd may come after the new session started
    hub.sessionEnded(TAB, SID)
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    hub.sessionEnded(TAB, NEXT)
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: NOT_RUNNING })
  })

  it('an assistant entry older than the dialog (the line that raised it, read late) does not answer it', async () => {
    const { hub } = setup()
    hub.sessionStarted(TAB, SID, 'startup')
    hub.dialogOpened(TAB, 'a1')
    hub.assistantEntry(TAB, 'a1', Date.now() - 1000)
    hub.assistantEntry(TAB, 'a1', Date.now())
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.assistantEntry(TAB, 'a2', later())
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.assistantEntry(TAB, 'a1', later())
    expect(hub.canSend(TAB)).toEqual({ ok: true })
  })

  it('a compaction keeps the open dialogs; any other session start closes them', async () => {
    const { hub } = setup()
    hub.sessionStarted(TAB, SID, 'startup')
    hub.dialogOpened(TAB, 'a1')
    hub.sessionStarted(TAB, SID, 'compact')
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.sessionStarted(TAB, SID, 'resume')
    expect(hub.canSend(TAB)).toEqual({ ok: true })
  })

  it('SubagentStop closes that subagent\'s dialog only', async () => {
    const { hub } = setup()
    hub.sessionStarted(TAB, SID, 'startup')
    hub.dialogOpened(TAB, 'a1')
    hub.dialogOpened(TAB, null)
    hub.subagentStopped(TAB, 'a2')
    hub.subagentStopped(TAB, 'a1')
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.turnEnded(TAB)
    expect(hub.canSend(TAB)).toEqual({ ok: true })
  })

  it('an interrupt (Esc, a denied prompt) newer than the dialog closes the dialog of its own transcript', async () => {
    const { hub, published } = setup()
    hub.sessionStarted(TAB, SID, 'startup')
    hub.dialogOpened(TAB, null)
    hub.dialogOpened(TAB, 'a1')
    hub.interrupted(TAB, null, Date.now() - 1000)
    hub.interrupted(TAB, 'a2', later())
    hub.interrupted(TAB, null, later())
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.interrupted(TAB, 'a1', later())
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(300)
    expect(published[published.length - 1]!.send).toEqual({ ok: true })
  })

  it('republishes the send state without computing again', async () => {
    const { hub, published, git } = setup()
    hub.sessionStarted(TAB, SID, 'startup')
    await vi.advanceTimersByTimeAsync(300)
    const computed = git.mock.calls.length
    hub.dialogOpened(TAB, null)
    expect(published[published.length - 1]!.send).toEqual({ ok: false, reason: IN_DIALOG })
    expect(git.mock.calls.length).toBe(computed)
  })
})

describe('ReviewHub edits', () => {
  it('records snapshots in the session ledger and starts turns', async () => {
    const seen: { scope: string; snaps: number }[] = []
    const { hub } = setup({
      ledger: (l, _log, scope) => { seen.push({ scope, snaps: (scope === 'session' ? l.sessionSnapshots() : l.lastTurnSnapshots() ?? []).length }); return result() }
    })
    hub.turn(TAB, SID, null)
    hub.recordBefore(TAB, SID, 'toolu_1', join(ROOT, 'a.ts'))
    hub.setScope(TAB, 'last_turn')
    await vi.advanceTimersByTimeAsync(0)
    expect(seen.some((s) => s.scope === 'last_turn' && s.snaps === 1)).toBe(true)
  })

  it('takes each transcript event once and triggers a compute on an edit', async () => {
    const logs: number[] = []
    const { hub } = setup({ ledger: (_l, log) => { logs.push(log.edits.length); return result() } })
    hub.sessionStarted(TAB, SID, 'startup')
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(0)
    const ev = { kind: 'edit' as const, at: 5, toolUseId: 'h1', path: join(ROOT, 'a.ts'), created: false, originalFile: 'x', patch: [] }
    hub.transcriptEvent(TAB, ev)
    hub.transcriptEvent(TAB, ev)
    await vi.advanceTimersByTimeAsync(300)
    expect(logs[logs.length - 1]).toBe(1)
  })

  it('keeps the original content of a file\'s first edit in each turn, by the turn the edit belongs to', async () => {
    const logs: TranscriptLog[] = []
    const { hub } = setup({ ledger: (_l, log) => { logs.push(log); return result() } })
    hub.sessionStarted(TAB, SID, 'startup')
    hub.setScope(TAB, 'session')
    const edit = (toolUseId: string, at: number, originalFile: string) =>
      ({ kind: 'edit' as const, at, toolUseId, path: join(ROOT, 'a.ts'), created: false, originalFile, patch: [] })
    hub.transcriptEvent(TAB, { kind: 'prompt', at: 100, id: 'p1' })
    hub.transcriptEvent(TAB, { kind: 'prompt', at: 300, id: 'p2' })
    hub.transcriptEvent(TAB, edit('m1', 350, 'turn 2'))
    hub.transcriptEvent(TAB, edit('m2', 360, 'turn 2 again'))
    // a subagent's transcript read after the later prompt: its edit is the first of turn 1
    hub.transcriptEvent(TAB, edit('s1', 150, 'turn 1'))
    await vi.advanceTimersByTimeAsync(300)
    expect(logs[logs.length - 1]!.edits.map((e) => [e.toolUseId, e.originalFile])).toEqual([['m1', 'turn 2'], ['m2', null], ['s1', 'turn 1']])
  })
})

describe('ReviewHub counter does not delay the view', () => {
  function held() {
    const releases: ((v: { files: number; additions: number; deletions: number }) => void)[] = []
    const totals = vi.fn(() => new Promise<{ files: number; additions: number; deletions: number }>((res) => { releases.push(res) }))
    return { totals, release: (n = 0, v = { files: 7, additions: 70, deletions: 3 }) => releases[n]!(v) }
  }
  const title = `Uncommitted changes in ${ROOT}`

  it('publishes the Last turn view before the Uncommitted counter is counted, then the new counter', async () => {
    const h = held()
    const { hub, published, last } = setup({ totals: h.totals })
    hub.setScope(TAB, 'last_turn')
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toHaveLength(1)
    expect(last()).toMatchObject({ label: 'last turn', counter: null })
    h.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toHaveLength(2)
    expect(last()).toMatchObject({ label: 'last turn', counter: { files: 7, additions: 70, deletions: 3, title } })
  })

  it('shows the last known counter meanwhile, and does not publish an unchanged counter again', async () => {
    const h = held()
    const { hub, published, last } = setup({ totals: h.totals })
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last().counter).toMatchObject({ files: 1 })
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toHaveLength(2)
    expect(last()).toMatchObject({ label: 'session', counter: { files: 1, additions: 1, deletions: 1 } })
    h.release(0, { files: 1, additions: 1, deletions: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toHaveLength(2)
  })

  it('a counter finishing after a scope switch lands on the new view, then the newest count follows', async () => {
    const h = held()
    const { hub, published, last } = setup({ totals: h.totals })
    const totals = h.totals
    hub.setScope(TAB, 'last_turn')
    await vi.advanceTimersByTimeAsync(0)
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ label: 'session', counter: null })
    // two views published, one count in flight
    expect(totals).toHaveBeenCalledTimes(1)
    h.release(0, { files: 3, additions: 3, deletions: 3 })
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ label: 'session', counter: { files: 3, additions: 3, deletions: 3, title } })
    // asked again once, for the newer view
    expect(totals).toHaveBeenCalledTimes(2)
    h.release(1, { files: 9, additions: 9, deletions: 9 })
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ label: 'session', counter: { files: 9, additions: 9, deletions: 9, title } })
    expect(published.every((u) => u.label !== 'last turn' || u.counter === null)).toBe(true)
  })

  it('many views while a count runs ask git at most twice', async () => {
    const h = held()
    const { hub, last } = setup({ totals: h.totals })
    const totals = h.totals
    hub.setScope(TAB, 'last_turn')
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) {
      hub.refresh(TAB)
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(totals).toHaveBeenCalledTimes(1)
    h.release(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(totals).toHaveBeenCalledTimes(2)
    h.release(1, { files: 4, additions: 4, deletions: 4 })
    await vi.advanceTimersByTimeAsync(0)
    expect(totals).toHaveBeenCalledTimes(2)
    expect(last().counter).toMatchObject({ files: 4 })
  })

  it('a tab closed while its count is pending publishes nothing and fails nothing', async () => {
    const h = held()
    const { hub, published, errors } = setup({ totals: h.totals })
    hub.setScope(TAB, 'last_turn')
    await vi.advanceTimersByTimeAsync(0)
    const n = published.length
    hub.removeTab(TAB)
    h.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toHaveLength(n)
    expect(errors).toEqual([])
  })

  it('a failing count publishes nothing and is logged once', async () => {
    const { hub, published, errors } = setup({ totals: async () => { throw new Error('git diff failed') } })
    hub.setScope(TAB, 'last_turn')
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toHaveLength(1)
    expect(errors).toEqual(['review: git diff failed'])
  })

  it('answers show_diff without waiting for the counter', async () => {
    const h = held()
    const { hub, last } = setup({ totals: h.totals })
    const res = await hub.showRequest(TAB, { cwd: ROOT, scope: 'session', from: null, to: null, paths: [], title: null })
    expect(res.ok).toBe(true)
    expect(last()).toMatchObject({ view: { kind: 'request' }, counter: null })
    h.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ view: { kind: 'request' }, counter: { files: 7 } })
  })
})
