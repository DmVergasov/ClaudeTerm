import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigWatch } from '../../src/main/mcp/config-watch'

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** polls until `cond` holds: fs.watch events can be slow on CI, so no fixed wait for a positive result */
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for the callback')
    await settle(20)
  }
}

// macOS may report the writes a test made just before its watch started (libuv's fs_event docs: "events collected by
// the OS immediately before calling uv_fs_event_start might be reported"): a test that counts the calls waits this
// long after the start and counts from there
const EARLIER_EVENTS_MS = 300

let watch: ConfigWatch | null = null
let root: string | null = null

afterEach(() => {
  watch?.close()
  watch = null
  if (root) rmSync(root, { recursive: true, force: true })
  root = null
})

function tempRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'ct-config-watch-'))
  return root
}

describe('ConfigWatch', () => {
  it('a write to a watched file calls back once after the debounce; another file of the folder does not', async () => {
    const dir = tempRoot()
    const file = join(dir, 'settings.json')
    const other = join(dir, 'other.json')
    writeFileSync(file, '{}')
    writeFileSync(other, '{}')
    let calls = 0
    watch = new ConfigWatch(() => calls++, { debounceMs: 50 })
    watch.setFiles([file])
    await settle(EARLIER_EVENTS_MS)
    calls = 0

    writeFileSync(other, '{"a":1}')
    await settle(400)
    expect(calls).toBe(0)

    writeFileSync(file, '{"a":1}')
    writeFileSync(file, '{"a":2}')
    await waitFor(() => calls === 1)
    await settle(200)
    expect(calls).toBe(1)
  })

  it('a file replaced by a rename (an atomic write) is seen', async () => {
    const dir = tempRoot()
    const file = join(dir, 'settings.json')
    const tmp = join(dir, 'settings.json.tmp')
    writeFileSync(file, '{}')
    let calls = 0
    watch = new ConfigWatch(() => calls++, { debounceMs: 50 })
    watch.setFiles([file])

    writeFileSync(tmp, '{"replaced":true}')
    renameSync(tmp, file)
    await waitFor(() => calls >= 1)
  })

  it('a missing folder is skipped and watched once setFiles names it again after it exists', async () => {
    const dir = tempRoot()
    const claudeDir = join(dir, '.claude')
    const file = join(claudeDir, 'settings.json')
    let calls = 0
    watch = new ConfigWatch(() => calls++, { debounceMs: 50 })
    watch.setFiles([file])

    mkdirSync(claudeDir)
    writeFileSync(file, '{}')
    await settle(300)
    expect(calls).toBe(0)

    watch.setFiles([file])
    writeFileSync(file, '{"a":1}')
    await waitFor(() => calls >= 1)
  })

  it('close stops the callbacks', async () => {
    const dir = tempRoot()
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{}')
    let calls = 0
    watch = new ConfigWatch(() => calls++, { debounceMs: 50 })
    watch.setFiles([file])
    watch.close()

    writeFileSync(file, '{"a":1}')
    await settle(400)
    expect(calls).toBe(0)
  })
  it('a setFiles that adds a file of an already watched folder arms the callback for it', async () => {
    const dir = tempRoot()
    const file = join(dir, 'settings.json')
    const other = join(dir, 'settings.local.json')
    writeFileSync(file, '{}')
    writeFileSync(other, '{}')
    let calls = 0
    watch = new ConfigWatch(() => calls++, { debounceMs: 50 })
    watch.setFiles([file])
    watch.setFiles([file, other])
    await settle(EARLIER_EVENTS_MS)
    calls = 0

    writeFileSync(other, '{"a":1}')
    await waitFor(() => calls >= 1)
    await settle(200)
    expect(calls).toBe(1)
  })

  it('a callback that throws or rejects does not stop the later callbacks', async () => {
    const dir = tempRoot()
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{}')
    let calls = 0
    watch = new ConfigWatch(
      () => {
        calls++
        if (calls === 1) throw new Error('first call fails')
        if (calls === 2) return Promise.reject(new Error('second call rejects'))
      },
      { debounceMs: 50 },
    )
    watch.setFiles([file])
    await settle(EARLIER_EVENTS_MS)
    calls = 0

    writeFileSync(file, '{"a":1}')
    await waitFor(() => calls === 1)
    await settle(200)
    writeFileSync(file, '{"a":2}')
    await waitFor(() => calls === 2)
    await settle(200)
    writeFileSync(file, '{"a":3}')
    await waitFor(() => calls === 3)
  })
})
