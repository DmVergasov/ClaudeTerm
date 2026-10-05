import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const MAX_BYTES = 1024 * 1024
const KEEP = 5

export function createLogger(dir: string): Logger {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'main.log')
  const rotate = (): void => {
    try {
      if (!existsSync(file) || statSync(file).size < MAX_BYTES) return
      rmSync(join(dir, `main.${KEEP - 1}.log`), { force: true })
      for (let i = KEEP - 2; i >= 1; i--) {
        const f = join(dir, `main.${i}.log`)
        if (existsSync(f)) renameSync(f, join(dir, `main.${i + 1}.log`))
      }
      renameSync(file, join(dir, 'main.1.log'))
    } catch {
      // logging must never crash the app
    }
  }
  const write = (level: string, message: string): void => {
    rotate()
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level} ${message}\n`)
    } catch {
      // ignore
    }
  }
  return { info: (m) => write('INFO', m), warn: (m) => write('WARN', m), error: (m) => write('ERROR', m) }
}
