import { app } from 'electron'
import { join } from 'node:path'

export function resourcePath(rel: string): string {
  return app.isPackaged ? join(process.resourcesPath, rel) : join(__dirname, '..', '..', 'resources', rel)
}
