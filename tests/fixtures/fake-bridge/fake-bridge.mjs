// The stand-in for the Agent SDK's bridge in the e2e tests: the six functions the bridge host calls, with no network. The app loads
// it instead of the SDK's bridge when CLAUDETERM_TEST_BRIDGE names it (CLAUDETERM_TEST=1). The test reads what the bridge recorded
// through globalThis.ctTestBridge, and holds an attach with globalThis.ctTestBridgeHold.

const calls = []
const handles = []

/** the handle's record, as the test reads it; its callbacks stay out of the snapshot */
function recordOf(sessionId) {
  return { sessionId, writes: [], results: 0, requests: [], cancels: [], states: [], closes: 0 }
}

const plain = (v) => JSON.parse(JSON.stringify(v))

/** the handle that is open last: a test's inbound message or answer goes to it */
function lastOpen() {
  for (let i = handles.length - 1; i >= 0; i--) if (handles[i].rec.closes === 0) return handles[i]
  return null
}

globalThis.ctTestBridge = {
  calls,
  handles,
  inbound(text) {
    const h = lastOpen()
    if (!h) return
    h.onInboundMessage({ type: 'user', session_id: '', message: { role: 'user', content: text }, parent_tool_use_id: null })
  },
  answer(requestId, behavior) {
    const h = lastOpen()
    if (!h) return undefined
    const response = behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'No' }
    return h.onPermissionResponse({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
  },
  snapshot() {
    return plain({ calls, handles: handles.map((h) => h.rec) })
  }
}

let sessions = 0

export function createCodeSession(apiBase, token, title, timeoutMs, oauthAccount, gitContext, cwd) {
  sessions += 1
  calls.push({ fn: 'create', token, title, cwd })
  return Promise.resolve(`cse_test${sessions}`)
}

export function fetchRemoteCredentials(sessionId, apiBase, token, timeoutMs, device) {
  calls.push({ fn: 'credentials', sessionId, token, device: device ?? null })
  return Promise.resolve({ worker_jwt: 'fake-worker-jwt-0001', api_base_url: 'https://bridge.example.invalid', expires_in: 3600, worker_epoch: 1 })
}

export async function attachBridgeSession(opts) {
  calls.push({ fn: 'attach', sessionId: opts.sessionId, initialSequenceNum: opts.initialSequenceNum ?? null })
  while (globalThis.ctTestBridgeHold === true) await new Promise((resolve) => setTimeout(resolve, 50))
  const rec = recordOf(opts.sessionId)
  const handle = {
    rec,
    onInboundMessage: opts.onInboundMessage,
    onPermissionResponse: opts.onPermissionResponse,
    onInterrupt: opts.onInterrupt,
    onClose: opts.onClose,
    write(msg) {
      rec.writes.push(plain(msg))
    },
    sendResult() {
      rec.results += 1
    },
    sendControlRequest(req) {
      rec.requests.push(plain(req))
    },
    sendControlCancelRequest(requestId) {
      rec.cancels.push(requestId)
    },
    reportState(state) {
      rec.states.push(state)
    },
    getSequenceNum() {
      return rec.writes.length
    },
    flush() {
      return Promise.resolve()
    },
    reconnectTransport() {
      return Promise.resolve()
    },
    close() {
      rec.closes += 1
    }
  }
  handles.push(handle)
  return handle
}

export function isCredentialsFailure(v) {
  return typeof v === 'object' && v !== null && typeof v.reason === 'string' && v.worker_jwt === undefined
}

export function isCredentialsRejection(v) {
  return typeof v === 'object' && v !== null && v.reason === 'oauth_rejected'
}

export function isCreateSessionFailure(v) {
  return typeof v === 'object' && v !== null && typeof v.reason === 'string'
}
