import { createServer, type Socket } from 'node:net'
import { type AgentListMessage, type AgentSendMessage, type AttentionMessage, type DeviceStatusMessage, type EditBeforeMessage, encodeMessage, type MailWaitMessage, type OpenDeviceSettingsMessage, parsePipeMessage, type PipeResponse, type SessionEndMessage, type SessionMessage, type ShowDiffMessage, type ShowDocumentMessage, type ShowImageMessage, type StatusMessage, type SubagentMessage, type TaskListGetMessage, type TaskListMessage, type TurnMessage } from '../shared/protocol'

export interface PipeHandlers {
  showImage(msg: ShowImageMessage): Promise<PipeResponse>
  session(msg: SessionMessage): PipeResponse
  status(msg: StatusMessage): PipeResponse
  subagent(msg: SubagentMessage): PipeResponse
  sessionEnd(msg: SessionEndMessage): PipeResponse
  attention(msg: AttentionMessage): PipeResponse
  turn(msg: TurnMessage): PipeResponse
  editBefore(msg: EditBeforeMessage): PipeResponse
  showDiff(msg: ShowDiffMessage): Promise<PipeResponse>
  showDocument(msg: ShowDocumentMessage): Promise<PipeResponse>
  taskList(msg: TaskListMessage): PipeResponse
  taskListGet(msg: TaskListGetMessage): PipeResponse
  deviceStatus(msg: DeviceStatusMessage): PipeResponse
  openDeviceSettings(msg: OpenDeviceSettingsMessage): PipeResponse
  agentList(msg: AgentListMessage): PipeResponse
  agentSend(msg: AgentSendMessage): PipeResponse
  /** held until the watcher has mail or is superseded; `closed` aborts when its socket closes */
  mailWait(msg: MailWaitMessage, closed: AbortSignal): Promise<PipeResponse>
}

export interface PipeServerHandle {
  close(): Promise<void>
}

const MAX_LINE = 64 * 1024

async function handleLine(line: string, h: PipeHandlers, closed: AbortSignal): Promise<PipeResponse> {
  const parsed = parsePipeMessage(line)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const m = parsed.message
  try {
    switch (m.type) {
      case 'show_image': return await h.showImage(m)
      case 'session': return h.session(m)
      case 'status': return h.status(m)
      case 'subagent': return h.subagent(m)
      case 'session_end': return h.sessionEnd(m)
      case 'attention': return h.attention(m)
      case 'turn': return h.turn(m)
      case 'edit_before': return h.editBefore(m)
      case 'show_diff': return await h.showDiff(m)
      case 'show_document': return await h.showDocument(m)
      case 'task_list': return h.taskList(m)
      case 'task_list_get': return h.taskListGet(m)
      case 'device_status': return h.deviceStatus(m)
      case 'open_device_settings': return h.openDeviceSettings(m)
      case 'agent_list': return h.agentList(m)
      case 'agent_send': return h.agentSend(m)
      case 'mail_wait': return await h.mailWait(m, closed)
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function startPipeServer(pipeName: string, handlers: PipeHandlers): Promise<PipeServerHandle> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    // aborted when the socket goes away: a held mail_wait then ends with it
    const gone = new AbortController()
    let buf = ''
    let chain: Promise<void> = Promise.resolve()
    let closed = false
    const enqueue = (task: () => Promise<void>): void => {
      chain = chain.then(task).catch(() => { /* keep the chain alive */ })
    }
    const reject = (): void => {
      closed = true
      buf = ''
      enqueue(async () => {
        if (!socket.destroyed) socket.end(encodeMessage({ ok: false, error: 'message too large' }))
      })
    }
    socket.on('data', (chunk: string) => {
      if (closed) return
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.length > MAX_LINE) return reject()
        if (!line) continue
        enqueue(async () => {
          const res = await handleLine(line, handlers, gone.signal)
          if (socket.writable) socket.write(encodeMessage(res))
        })
      }
      if (buf.length > MAX_LINE) reject()
    })
    socket.on('error', () => { /* client went away */ gone.abort() })
    socket.on('close', () => {
      sockets.delete(socket)
      gone.abort()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipeName, () => {
      server.off('error', reject)
      resolve({
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy()
            server.close(() => done())
          })
      })
    })
  })
}
