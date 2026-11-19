// A stand-in for a running Chromium browser with remote debugging on. Invented data only.
//
//   node stand-in-devtools.mjs --user-data-dir=<udd> [chrome://inspect/#remote-debugging]
//
// It listens on 127.0.0.1:0, writes <udd>/DevToolsActivePort, and answers the few CDP methods the live reader uses,
// from <udd>/stand-in-contexts.json: [{ contextId, pages: [{ targetId, title, url }], cookies: CdpCookie[] }].
// Every method it receives is appended to <udd>/stand-in-methods.log; a setup-page argument is appended to
// <udd>/stand-in-opened.log. STAND_IN_ALLOW_MS delays the handshake answer (the browser's "Allow?" prompt);
// STAND_IN_DENY=1 then drops the socket instead of answering (the person said no). STAND_IN_SILENT=<m1>,<m2> lists
// methods that are never answered. Only the path /devtools/browser/stand-in is an endpoint; any other upgrade gets a 404.
// It exits when its client closes, or after 60 s without a message. It prints nothing.
//
// Test-only methods: Stand.noAnswer is never answered; Stand.junk sends non-JSON and non-object text before its answer.

const ENDPOINT = '/devtools/browser/stand-in'

import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const IDLE_MS = 60_000
const SETUP_URL = /^(chrome|edge|brave):\/\/inspect\/#remote-debugging$/

const udd = process.argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
if (!udd) process.exit(1)
for (const arg of process.argv.slice(2)) {
  if (SETUP_URL.test(arg)) appendFileSync(join(udd, 'stand-in-opened.log'), `${arg}\n`)
}
const allowMs = Number(process.env.STAND_IN_ALLOW_MS) || 0
const deny = process.env.STAND_IN_DENY === '1'
const silent = new Set((process.env.STAND_IN_SILENT ?? '').split(',').filter((m) => m !== ''))
const portFile = join(udd, 'DevToolsActivePort')

let idleTimer = null
function resetIdle() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(stop, IDLE_MS)
}

function stop() {
  try {
    rmSync(portFile, { force: true })
  } catch {
    // best effort: the test deletes its folder anyway
  }
  server.close()
  process.exit(0)
}

function contexts() {
  try {
    const parsed = JSON.parse(readFileSync(join(udd, 'stand-in-contexts.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function allPages() {
  const out = []
  for (const ctx of contexts()) {
    for (const page of ctx.pages ?? []) out.push({ ...page, browserContextId: ctx.contextId })
  }
  return out
}

function contextOfTarget(targetId) {
  return contexts().find((ctx) => (ctx.pages ?? []).some((p) => p.targetId === targetId))
}

function handle(msg) {
  const { id, method, params = {}, sessionId } = msg
  appendFileSync(join(udd, 'stand-in-methods.log'), `${method}\n`)
  if (method === 'Stand.noAnswer' || silent.has(method)) return null
  if (method === 'Target.getTargets') {
    const targetInfos = allPages().map((p) => ({
      targetId: p.targetId,
      type: 'page',
      title: p.title,
      url: p.url,
      attached: false,
      browserContextId: p.browserContextId,
    }))
    return { result: { targetInfos } }
  }
  if (method === 'Target.attachToTarget') {
    if (params.flatten !== true) return { error: { code: -32602, message: 'flatten must be true' } }
    const known = allPages().some((p) => p.targetId === params.targetId)
    if (!known) return { error: { code: -32602, message: 'No target with given id found' } }
    return { result: { sessionId: `s-${params.targetId}` } }
  }
  if (method === 'Target.detachFromTarget') return { result: {} }
  if (method === 'Network.getAllCookies') {
    const targetId = typeof sessionId === 'string' && sessionId.startsWith('s-') ? sessionId.slice(2) : ''
    const ctx = contextOfTarget(targetId)
    if (!ctx) return { error: { code: -32001, message: 'Session with given id not found' } }
    return { result: { cookies: ctx.cookies ?? [] } }
  }
  return { error: { code: -32601, message: `'${method}' wasn't found` }, id }
}

// A text frame from the server is unmasked.
function frame(opcode, payload) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

const server = createServer((req, res) => {
  resetIdle()
  res.writeHead(404)
  res.end()
})

server.on('upgrade', (req, socket) => {
  resetIdle()
  socket.on('error', () => {})
  if (req.url !== ENDPOINT) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  const key = req.headers['sec-websocket-key']
  const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64')
  let buf = Buffer.alloc(0)
  let open = false

  const send = (obj) => socket.write(frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')))

  const onFrame = (opcode, payload) => {
    if (opcode === 0x8) {
      socket.write(frame(0x8, Buffer.alloc(0)))
      socket.end()
      return
    }
    if (opcode === 0x9) {
      socket.write(frame(0xa, payload))
      return
    }
    if (opcode !== 0x1) return
    resetIdle()
    let msg
    try {
      msg = JSON.parse(payload.toString('utf8'))
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return
    if (msg.method === 'Stand.junk') {
      socket.write(frame(0x1, Buffer.from('this is not json', 'utf8')))
      socket.write(frame(0x1, Buffer.from('[1, 2]', 'utf8')))
      send({ id: msg.id, result: { ok: true } })
      return
    }
    const answer = handle(msg)
    if (answer === null) return
    send({ id: msg.id, ...answer })
  }

  const parse = () => {
    for (;;) {
      if (buf.length < 2) return
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        off = 10
      }
      let mask = null
      if (masked) {
        if (buf.length < off + 4) return
        mask = buf.subarray(off, off + 4)
        off += 4
      }
      if (buf.length < off + len) return
      const payload = Buffer.from(buf.subarray(off, off + len))
      buf = buf.subarray(off + len)
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      onFrame(opcode, payload)
    }
  }

  const start = () => {
    if (socket.destroyed) return
    if (deny) {
      socket.destroy()
      return
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    open = true
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      parse()
    })
    // the one client has gone: the browser is done with this run
    socket.on('close', () => {
      if (open) stop()
    })
    socket.on('end', () => {
      if (open) stop()
    })
  }
  if (allowMs > 0) setTimeout(start, allowMs)
  else start()
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  writeFileSync(portFile, `${port}\n${ENDPOINT}\n`)
  resetIdle()
})

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
