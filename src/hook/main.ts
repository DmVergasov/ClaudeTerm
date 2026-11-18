import { sendPipeMessage } from '../shared/pipe-client'
import type { PipeMessage } from '../shared/protocol'
import { runMailWatch } from './mail-watch'
import { runSessionHook, runStatusLine } from './session-hook'

// Never write to stdout: SessionStart hook stdout is added to Claude's context, and statusLine stdout
// is shown in Claude's own status row (kept empty: ClaudeTerm shows the data in its status bar).
// The exceptions: the UserPromptSubmit hook of a coordinator tab, or of a session on a coordinator's task, which prints one JSON line whose
// additionalContext is the coordinator's instruction, which Claude Code adds to that turn (see turnContextLine), and the PreToolUse hook of an
// AskUserQuestion, which prints the deny decision main gives for the question (see askDecisionLine).
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

/**
 * How long the hook waits for main's answer. An edit and a question wait longer: main's answer decides what the hook prints, and a question
 * main took after the hook gave up would open its form beside the question.
 */
function answerWaitMs(msg: PipeMessage): number {
  if (msg.type === 'edit_before') return 8000
  if (msg.type === 'attention' && msg.reason === 'question') return 8000
  return 2000
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
        : runSessionHook(text, process.env, (pipe, msg) => sendPipeMessage(pipe, msg, answerWaitMs(msg)))
    )
    .catch(() => '')
    .then((out) => {
      // the exit waits for the write to be flushed, or the instruction is lost
      if (out === '') process.exit(0)
      else process.stdout.write(out, () => process.exit(0))
    })
    .catch(() => process.exit(0))
}
