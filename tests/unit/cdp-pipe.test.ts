import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CdpPipe } from '../../src/main/browser-import/cdp-pipe'

// The browser side of the pipe is two in-memory streams: what the pipe writes comes out of `written`, and
// what the browser sends goes into `browser`.

function setup(): { pipe: CdpPipe; browser: PassThrough; written: string[] } {
  const toBrowser = new PassThrough()
  const fromBrowser = new PassThrough()
  const written: string[] = []
  toBrowser.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')))
  return { pipe: new CdpPipe(toBrowser, fromBrowser), browser: fromBrowser, written }
}

// The id of the last command the pipe wrote.
function lastId(written: string[]): number {
  const text = written.join('').split('\0').filter((s) => s !== '').at(-1) ?? '{}'
  return (JSON.parse(text) as { id: number }).id
}

// A message as the browser sends it on fd 4: JSON, then a NUL byte.
function frame(message: unknown): string {
  return `${JSON.stringify(message)}\0`
}

// Lets the streams deliver what was written to them.
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('CdpPipe', () => {
  it('writes NUL-terminated commands with ids that start at 1 and increase', async () => {
    const { pipe, written } = setup()
    const first = pipe.send('Browser.getVersion')
    await tick()
    expect(written.join('')).toBe(`${JSON.stringify({ id: 1, method: 'Browser.getVersion', params: {} })}\0`)
    const second = pipe.send('Storage.getCookies', { x: 1 })
    await tick()
    expect(lastId(written)).toBe(2)
    pipe.close()
    await expect(first).rejects.toThrow('closed')
    await expect(second).rejects.toThrow('closed')
  })

  it('resolves a reply that arrives split across chunks', async () => {
    const { pipe, browser, written } = setup()
    const answer = pipe.send<{ cookies: unknown[] }>('Storage.getCookies')
    await tick()
    const reply = frame({ id: lastId(written), result: { cookies: [{ name: 'n' }] } })
    browser.write(reply.slice(0, 7))
    await tick()
    browser.write(reply.slice(7))
    await expect(answer).resolves.toEqual({ cookies: [{ name: 'n' }] })
    pipe.close()
  })

  it('ignores garbage, events and replies for ids that are not pending', async () => {
    const { pipe, browser, written } = setup()
    const answer = pipe.send<string>('Browser.getVersion')
    await tick()
    const id = lastId(written)
    browser.write('this is not json\0')
    browser.write(frame({ method: 'Target.attachedToTarget', params: {} }))
    browser.write(frame({ id: id + 100, result: 'for nobody' }))
    browser.write(frame({ id, result: 'the answer' }))
    await expect(answer).resolves.toBe('the answer')
    pipe.close()
  })

  it('rejects a protocol error with the method name only', async () => {
    const { pipe, browser, written } = setup()
    const answer = pipe.send('Network.setCookie')
    await tick()
    browser.write(frame({ id: lastId(written), error: { code: -32601, message: 'secret cookie value' } }))
    await expect(answer).rejects.toThrow('Network.setCookie failed')
    await expect(answer).rejects.not.toThrow('secret')
    pipe.close()
  })

  it('close rejects the pending calls with closed, and a send after close rejects at once', async () => {
    const { pipe } = setup()
    const pending = pipe.send('Browser.getVersion')
    pipe.close()
    await expect(pending).rejects.toThrow('closed')
    await expect(pipe.send('Browser.getVersion')).rejects.toThrow('closed')
  })

  it('a call with no answer in time rejects with a timeout error', async () => {
    const { pipe } = setup()
    await expect(pipe.send('Browser.getVersion', {}, 20)).rejects.toThrow('Browser.getVersion did not answer')
    pipe.close()
  })

  it('closes the pipe when a message grows past 64 MiB without its NUL byte', async () => {
    const { pipe, browser, written } = setup()
    const pending = pipe.send('Storage.getCookies')
    await tick()
    expect(written.length).toBeGreaterThan(0)
    const megabyte = Buffer.alloc(1024 * 1024, 0x61)
    for (let i = 0; i < 65; i++) browser.write(megabyte)
    await expect(pending).rejects.toThrow('closed')
    await expect(pipe.send('Browser.getVersion')).rejects.toThrow('closed')
  }, 30_000)
})
