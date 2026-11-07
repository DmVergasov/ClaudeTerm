import { PipeUnavailableError } from '../shared/pipe-client'
import type { DeviceStatusMessage, OpenDeviceSettingsMessage, PipeResponse } from '../shared/protocol'
import type { ToolResult } from './show-image-tool'

export interface DeviceStatusDeps {
  pipeName: string
  send(pipeName: string, msg: DeviceStatusMessage): Promise<PipeResponse>
}

export interface OpenDeviceSettingsDeps {
  pipeName: string
  send(pipeName: string, msg: OpenDeviceSettingsMessage): Promise<PipeResponse>
}

export function handleDeviceStatus(deps: DeviceStatusDeps): Promise<ToolResult> {
  return ask(
    () => deps.send(deps.pipeName, { v: 1, type: 'device_status' }),
    'ClaudeTerm is not running, so there is no device sync status to show',
    (info) => info ?? 'Device sync status is not available.'
  )
}

export function handleOpenDeviceSettings(deps: OpenDeviceSettingsDeps): Promise<ToolResult> {
  return ask(
    () => deps.send(deps.pipeName, { v: 1, type: 'open_device_settings' }),
    'ClaudeTerm is not running, so there is no Settings window to open',
    () => 'Opened Settings → Devices in ClaudeTerm.'
  )
}

/** one pipe call as a tool answer: the pipe's text on success, its error or a missing ClaudeTerm as an error */
async function ask(send: () => Promise<PipeResponse>, notRunning: string, okText: (info: string | undefined) => string): Promise<ToolResult> {
  let res: PipeResponse
  try {
    res = await send()
  } catch (e) {
    if (e instanceof PipeUnavailableError) return { text: notRunning, isError: true }
    return { text: `ClaudeTerm request failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
  return res.ok ? { text: okText(res.info), isError: false } : { text: res.error, isError: true }
}
