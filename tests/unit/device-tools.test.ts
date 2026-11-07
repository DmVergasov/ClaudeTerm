import { describe, expect, it } from 'vitest'
import { PipeUnavailableError } from '../../src/shared/pipe-client'
import { handleDeviceStatus, handleOpenDeviceSettings } from '../../src/mcp/device-tools'

describe('handleDeviceStatus', () => {
  it("the pipe's answer becomes the tool text; a pipe that is not there gives ClaudeTerm is not running", async () => {
    expect(await handleDeviceStatus({ pipeName: 'p', send: async () => ({ ok: true, info: 'status' }) })).toEqual({ text: 'status', isError: false })
    expect((await handleDeviceStatus({ pipeName: 'p', send: async () => { throw new PipeUnavailableError('p') } })).text).toMatch(/ClaudeTerm is not running/)
  })

  it('sends the device_status message to the pipe, and an error answer is an error', async () => {
    const sent: unknown[] = []
    const r = await handleDeviceStatus({ pipeName: 'the-pipe', send: async (pipe, msg) => { sent.push([pipe, msg]); return { ok: false, error: 'busy' } } })
    expect(sent).toEqual([['the-pipe', { v: 1, type: 'device_status' }]])
    expect(r).toEqual({ text: 'busy', isError: true })
  })
})

describe('handleOpenDeviceSettings', () => {
  it('sends open_device_settings and answers that Settings opened at Devices', async () => {
    const sent: unknown[] = []
    const r = await handleOpenDeviceSettings({ pipeName: 'the-pipe', send: async (pipe, msg) => { sent.push([pipe, msg]); return { ok: true } } })
    expect(sent).toEqual([['the-pipe', { v: 1, type: 'open_device_settings' }]])
    expect(r).toEqual({ text: 'Opened Settings → Devices in ClaudeTerm.', isError: false })
  })

  it('says ClaudeTerm is not running when the pipe is not there', async () => {
    const r = await handleOpenDeviceSettings({ pipeName: 'p', send: async () => { throw new PipeUnavailableError('p') } })
    expect(r).toEqual({ text: 'ClaudeTerm is not running, so there is no Settings window to open', isError: true })
  })
})
