import { sendPipeMessage } from '../shared/pipe-client'
import { runSessionHook, runStatusLine } from './session-hook'

// Never write to stdout: SessionStart hook stdout is added to Claude's context, and statusLine stdout
// is shown in Claude's own status row (kept empty: ClaudeTerm shows the data in its status bar).
function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    const done = (): void => {
      clearTimeout(timer)
      resolve(data)
    }
    const timer = setTimeout(done, timeoutMs)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => { data += chunk })
    process.stdin.on('end', done)
    process.stdin.on('error', done)
  })
}

const statusLine = process.argv.slice(2).includes('status')

Promise.resolve()
  .then(() => readStdin(3000))
  .then((text) =>
    statusLine
      ? runStatusLine(text, process.env, (pipe, msg) => sendPipeMessage(pipe, msg, 1000))
      : runSessionHook(text, process.env, (pipe, msg) => sendPipeMessage(pipe, msg, 2000))
  )
  .catch(() => false)
  .finally(() => process.exit(0))
