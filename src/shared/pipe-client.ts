import { connect } from 'node:net'
import { encodeMessage, type PipeMessage, type PipeResponse } from './protocol'

export class PipeUnavailableError extends Error {}

export function sendPipeMessage(pipeName: string, msg: PipeMessage, timeoutMs = 2000): Promise<PipeResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipeName)
    let buf = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new PipeUnavailableError(`timed out talking to ${pipeName}`))), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(encodeMessage(msg)))
    socket.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      finish(() => {
        try {
          resolve(JSON.parse(line) as PipeResponse)
        } catch {
          reject(new Error('invalid response from ClaudeTerm'))
        }
      })
    })
    socket.on('error', (e) => finish(() => reject(new PipeUnavailableError(e.message))))
    socket.on('close', () => finish(() => reject(new PipeUnavailableError('connection closed without a response'))))
  })
}
