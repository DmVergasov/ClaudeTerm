import { SHARE_ENV, Worker } from 'node:worker_threads'

/*
 * Programs the main process runs often (git, the sound player) start in a worker thread. Node starts a process in the
 * thread that asks, and on a busy Windows machine CreateProcess now and then takes a second or more: in the main process
 * that second would freeze the window's input, its tab switches and the output of every terminal.
 */

/** what a program answered */
export interface RunResult {
  /** its exit code; 1 when a signal ended it */
  code: number
  stdout: Buffer
  /** the start of its stderr, about 4 KB */
  stderr: string
}

export interface RunOptions {
  cwd?: string
  /** the main process's environment when left out, as it is when the program starts */
  env?: NodeJS.ProcessEnv
  /** written to its stdin, which is then closed */
  input?: string
  /** no stdin, stdout or stderr: the result has empty output */
  quiet?: boolean
  /** the program is ended and RunError 'timeout' given after this long */
  timeoutMs?: number
  /** the program is ended and RunError 'too-large' given once its stdout is larger */
  maxOutput?: number
}

export type RunFailure = 'not-found' | 'failed' | 'timeout' | 'too-large'

export class RunError extends Error {
  constructor(readonly reason: RunFailure, message: string) {
    super(message)
  }
}

interface Request extends Omit<RunOptions, 'env'> {
  id: number
  file: string
  args: string[]
  env: NodeJS.ProcessEnv | undefined
}

type Answer =
  | { id: number; code: number; stdout: Uint8Array; stderr: string }
  | { id: number; error: { reason: RunFailure; message: string } }

// the worker as source: a file of its own would need its own place in each build, in the app's package and in the tests
const WORKER = `
const { parentPort } = require('node:worker_threads')
const { spawn } = require('node:child_process')
parentPort.on('message', (m) => {
  let settled = false
  let timer
  const answer = (a, transfer) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    parentPort.postMessage({ id: m.id, ...a }, transfer)
  }
  const fail = (reason, message) => answer({ error: { reason, message } })
  let child
  try {
    child = spawn(m.file, m.args, { cwd: m.cwd, env: m.env, windowsHide: true, stdio: m.quiet ? 'ignore' : ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    fail('failed', String(e && e.message))
    return
  }
  if (m.timeoutMs !== undefined) timer = setTimeout(() => { child.kill(); fail('timeout', 'took too long') }, m.timeoutMs)
  const out = []
  let size = 0
  let err = ''
  if (!m.quiet) {
    child.stdout.on('data', (c) => {
      size += c.length
      if (m.maxOutput !== undefined && size > m.maxOutput) {
        child.kill()
        fail('too-large', 'output too large')
        return
      }
      out.push(c)
    })
    child.stderr.on('data', (c) => { if (err.length < 4096) err += c.toString('utf8') })
    child.stdin.on('error', () => { /* it exited before reading everything */ })
    child.stdin.end(m.input ?? '')
  }
  child.on('error', (e) => fail(e.code === 'ENOENT' ? 'not-found' : 'failed', e.message))
  child.on('close', (code) => {
    // a buffer of its own: a pooled one would take its neighbours along when transferred
    const stdout = new Uint8Array(out.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of out) { stdout.set(c, at); at += c.length }
    answer({ code: code ?? 1, stdout, stderr: err }, [stdout.buffer])
  })
})
`

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve(r: RunResult): void; reject(e: Error): void }>()

function started(): Worker {
  if (worker) return worker
  // SHARE_ENV: a program started without env gets the main process's environment as it is then, not as it was here
  const w = new Worker(WORKER, { eval: true, env: SHARE_ENV })
  w.on('message', (a: Answer) => {
    const p = pending.get(a.id)
    if (!p) return
    pending.delete(a.id)
    // an idle worker does not keep the process alive
    if (pending.size === 0) w.unref()
    if ('error' in a) p.reject(new RunError(a.error.reason, a.error.message))
    else p.resolve({ code: a.code, stdout: Buffer.from(a.stdout.buffer, a.stdout.byteOffset, a.stdout.byteLength), stderr: a.stderr })
  })
  const gone = (why: string): void => {
    if (worker !== w) return
    worker = null
    for (const p of pending.values()) p.reject(new RunError('failed', `the program starter stopped: ${why}`))
    pending.clear()
  }
  w.on('error', (e) => gone(e.message))
  w.on('exit', (code) => gone(`exit code ${code}`))
  worker = w
  return w
}

/** Runs a program to its end without a shell, started off the main thread. Rejects with RunError. */
export function runOffThread(file: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let w: Worker
    try {
      w = started()
    } catch (e) {
      reject(new RunError('failed', `cannot start the program starter: ${(e as Error).message}`))
      return
    }
    const id = nextId++
    pending.set(id, { resolve, reject })
    w.ref()
    const { env, ...rest } = o
    const req: Request = { ...rest, id, file, args, env }
    w.postMessage(req)
  })
}
