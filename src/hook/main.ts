import { sendPipeMessage } from '../shared/pipe-client'
import { runMailWatch } from './mail-watch'
import { runSessionHook, runStatusLine } from './session-hook'

// Never write to stdout: SessionStart hook stdout is added to Claude's context, and statusLine stdout
// is shown in Claude's own status row (kept empty: ClaudeTerm shows the data in its status bar).
// The one exception: the UserPromptSubmit hook of a coordinator tab prints one JSON line whose additionalContext is the
// coordinator's instruction, which Claude Code adds to that turn (see turnContextLine).
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

const args = process.argv.slice(2)
const statusLine = args.includes('status')
const mail = args.includes('mail')

if (mail) {
  // the mail watcher: the only mode that writes to stderr and exits 2, which Claude Code reads as mail for the model
  // (asyncRewake); its answer has no time limit, the watcher waits as long as main holds it
  Promise.resolve()
    .then(() => readStdin(3000))
    .then((text) => runMailWatch(text, process.env, (pipe, msg) => sendPipeMessage(pipe, msg, null)))
    .then(({ code, stderr }) => {
      // the exit waits for the write to be flushed, or the mail is lost
      if (stderr) process.stderr.write(stderr, () => process.exit(code))
      else process.exit(code)
    })
    .catch(() => process.exit(0))
} else {
  Promise.resolve()
    .then(() => readStdin(3000))
    .then((text) =>
      statusLine
        ? runStatusLine(text, process.env, (pipe, msg) => sendPipeMessage(pipe, msg, 1000)).then(() => '')
        : runSessionHook(text, process.env, (pipe, msg) => sendPipeMessage(pipe, msg, msg.type === 'edit_before' ? 8000 : 2000))
    )
    .catch(() => '')
    .then((out) => {
      // the exit waits for the write to be flushed, or the instruction is lost
      if (out === '') process.exit(0)
      else process.stdout.write(out, () => process.exit(0))
    })
    .catch(() => process.exit(0))
}
