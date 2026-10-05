import { app } from 'electron'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { defaultPipeName } from '../shared/protocol'

export function initDataDir(): string {
  const override = process.env.CLAUDETERM_DATA_DIR
  if (override) app.setPath('userData', override)
  else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'ClaudeTerm-dev'))
  return app.getPath('userData')
}

export function resolvePipeName(): string {
  const user = userInfo().username
  return process.env.CLAUDETERM_PIPE_NAME ?? defaultPipeName(app.isPackaged ? user : `dev-${user}`)
}
