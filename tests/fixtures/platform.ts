import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** true when the tests run on Windows; for the steps only one platform can run */
export const WIN = process.platform === 'win32'

/** A fresh address for a test server: a named pipe on Windows, a socket file in the temp folder elsewhere (kept short: a socket path has ~100 bytes) */
export function testPipeName(tag: string): string {
  const id = randomUUID()
  return WIN ? `\\\\.\\pipe\\claudeterm-${tag}-${id}` : join(tmpdir(), `ct-${tag}-${id.slice(0, 8)}.sock`)
}
