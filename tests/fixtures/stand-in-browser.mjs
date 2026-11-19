// A stand-in for a Chromium browser in the import tests. It takes the same switches, speaks CDP over
// --remote-debugging-pipe (NUL-terminated JSON: the parent writes fd 3, this script reads it; it writes fd 4) and
// answers from a JSON file of cookies. It uses Node built-ins only, so it runs as ELECTRON_RUN_AS_NODE too.
//
// Environment:
//   STAND_IN_HANG=1         never answers anything
//   STAND_IN_HANG=cookies   answers Browser.getVersion, never answers Storage.getCookies
//   STAND_IN_START_MS=n     waits n ms before answering Browser.getVersion (a slow first start)
//   STAND_IN_IGNORE_TERM=1  ignores SIGTERM, like a browser that is stuck

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const argv = process.argv.slice(2)

function switchValue(name) {
  const prefix = `--${name}=`
  const found = argv.find((a) => a.startsWith(prefix))
  return found === undefined ? undefined : found.slice(prefix.length)
}

const userDataDir = switchValue('user-data-dir')
const profileDir = switchValue('profile-directory')
if (userDataDir === undefined || profileDir === undefined) process.exit(2)

// What the caller asked for, so a test can check the switches: next to the user-data folder.
writeFileSync(join(dirname(userDataDir), 'stand-in-args.json'), JSON.stringify(argv))

if (!existsSync(join(userDataDir, 'Local State'))) process.exit(3)

if (process.env.STAND_IN_IGNORE_TERM === '1') process.on('SIGTERM', () => {})

const cookieFile = join(userDataDir, profileDir, 'Network', 'Cookies')
const cookies = existsSync(cookieFile) ? JSON.parse(readFileSync(cookieFile, 'utf8')) : []
const hang = process.env.STAND_IN_HANG ?? ''
const startMs = Number(process.env.STAND_IN_START_MS ?? 0)

const input = new net.Socket({ fd: 3, readable: true, writable: false })
const output = new net.Socket({ fd: 4, readable: false, writable: true })
const decoder = new StringDecoder('utf8')
let pending = ''

input.on('data', (chunk) => {
  pending += decoder.write(chunk)
  let end = pending.indexOf('\0')
  while (end !== -1) {
    const text = pending.slice(0, end)
    pending = pending.slice(end + 1)
    handle(text)
    end = pending.indexOf('\0')
  }
})
// The parent closed its end: nothing more to answer.
input.on('end', () => process.exit(0))
input.on('error', () => process.exit(0))
output.on('error', () => process.exit(0))

function send(message, then) {
  output.write(`${JSON.stringify(message)}\0`, then)
}

function handle(text) {
  if (hang === '1') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  if (typeof message !== 'object' || message === null || typeof message.id !== 'number') return
  switch (message.method) {
    case 'Browser.getVersion':
      setTimeout(() => send({ id: message.id, result: { product: 'stand-in', protocolVersion: '1.3' } }), startMs)
      return
    case 'Storage.getCookies':
      if (hang === 'cookies') return
      send({ id: message.id, result: { cookies } })
      return
    case 'Browser.close':
      send({ id: message.id, result: {} }, () => process.exit(0))
      return
    default:
      send({ id: message.id, error: { code: -32601, message: `'${message.method}' wasn't found` } })
  }
}
