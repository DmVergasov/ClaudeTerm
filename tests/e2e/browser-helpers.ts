import type { ElectronApplication } from '@playwright/test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { PipeMessage } from '../../src/shared/protocol'

/** what the pipe answers to a browser command, as the tests read it */
export interface Reply {
  ok: boolean
  info?: string
  error?: string
  image?: { data: string; mimeType: string }
}

export interface SiteServer {
  port: number
  /** an address on the server; the host defaults to 127.0.0.1, `other.test` resolves there too in test runs */
  url(path: string, host?: string): string
  close(): Promise<void>
}

const page = (title: string, body: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`

/** the pages the tests browse, by path; `port` is the server's own, for the links and redirects that name it */
function pageFor(path: string, port: number, req: IncomingMessage, loads: number): { status: number; type: string; body: string; headers?: Record<string, string> } | null {
  const html = (body: string): { status: number; type: string; body: string } => ({ status: 200, type: 'text/html; charset=utf-8', body })
  switch (path) {
    case '/form':
      return html(page('Form', '<label for="name">Name</label> <input id="name"> <button onclick="document.getElementById(\'out\').textContent = \'saved:\' + document.getElementById(\'name\').value">Save</button> <div id="out"></div>'))
    case '/console':
      return html(page('Console', '<p>Logs an error</p><script>console.error("boom")</script>'))
    case '/link':
      return html(page('Link', `<a href="http://other.test:${port}/page">Other</a>`))
    case '/redirect':
      return { status: 302, type: 'text/plain', body: '', headers: { Location: `http://other.test:${port}/page` } }
    case '/redirect2':
      return { status: 302, type: 'text/plain', body: '', headers: { Location: '/redirect' } }
    case '/post':
      return html(page('Post', `<form method="post" action="http://other.test:${port}/page"><button type="submit">Send</button></form>`))
    case '/away':
      return { status: 302, type: 'text/plain', body: '', headers: { Location: `http://other.test:${port}/redirect` } }
    case '/page':
      return html(page('Other page', '<p>Another page of the site</p>'))
    case '/cookie':
      return html(page('Cookie', `<pre id="c"></pre><script>document.getElementById("c").textContent = ${JSON.stringify(req.headers.cookie ?? '')}</script>`))
    case '/download':
      return { status: 200, type: 'text/plain', body: 'downloaded text', headers: { 'Content-Disposition': 'attachment; filename=a.txt' } }
    case '/select':
      return html(page('Select', '<label for="color">Color</label> <select id="color"><option>red</option><option>green</option><option>blue</option></select> <div id="out"></div><script>document.getElementById("color").addEventListener("change", (e) => { document.getElementById("out").textContent = e.target.value })</script>'))
    case '/fetch':
      // a page whose script fetches /redirect when a test asks (a fetch at load runs before the debugger is attached)
      return html(page('Fetch', '<p>Fetches a route that redirects, when asked</p>'))
    case '/closer':
      return html(page('Closer', '<p>A page of its own</p>'))
    case '/popup':
      return html(page('Popup host', '<p>Opens a window of another site when a script asks</p>'))
    case '/count':
      return html(page(`Load ${loads}`, '<p>Counts its loads</p>'))
    case '/dialog':
      return html(page('Dialog', '<button onclick="document.title = String(confirm(\'Sure?\'))">Ask</button>'))
    case '/guard':
      return html(page('Guard', '<button onclick="window.onbeforeunload = (e) => { e.preventDefault(); e.returnValue = \'\' }">Arm</button>'))
    default:
      return null
  }
}

/**
 * A small site on 127.0.0.1 on a free port, for the browser tests: a form, a console error, redirects, a download, a select,
 * a page that asks a confirm, /away (a redirect to other.test's /redirect, which redirects to its /page), a page of "another" site
 * (other.test, which the tests map to 127.0.0.1), /count (its title counts
 * its loads: `Load <n>`), /guard (an Arm button that makes the page guard its unload: the page asks "Leave site?")
 * and /slow (its head is sent at once and its body is held for 20 s, so the page stays loading)
 */
export function startSiteServer(): Promise<SiteServer> {
  return new Promise((resolve, reject) => {
    // how often /count has been loaded
    let countLoads = 0
    const server = createServer((req, res: ServerResponse) => {
      const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1')
      const port = (server.address() as AddressInfo).port
      if (pathname === '/slow') {
        // the head goes out at once and the body is held: the page stays loading until the client leaves or 20 s pass
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.write(page('Slow', '<p>Loading slowly</p>'))
        const timer = setTimeout(() => res.end('</body>'), 20_000)
        res.on('close', () => clearTimeout(timer))
        return
      }
      if (pathname === '/count') countLoads++
      const found = pageFor(pathname, port, req, countLoads)
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      res.writeHead(found.status, { 'Content-Type': found.type, ...found.headers })
      res.end(found.body)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        url: (path, host = '127.0.0.1') => `http://${host}:${port}${path}`,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections()
          server.close(() => done())
        })
      })
    })
  })
}

/**
 * Playwright sees the browser's pages too, and dismisses a dialog that no one listens to: Electron shows no dialog, so that
 * dismissal fails and fails the test. A listener on the app's context covers every page, the ones made later too, so a
 * guarded page's beforeunload prompt is left to ClaudeTerm, which answers it. Call it once, after the app launches.
 */
export function leavePromptsToClaudeTerm(app: ElectronApplication): void {
  app.context().on('dialog', () => undefined)
}

/** one browser command sent through the pipe, as the MCP server sends it; the pipe fills in the defaults of the optional fields */
export function browserCmd(pipeName: string, tabId: string, command: object, timeoutMs = 60_000): Promise<Reply> {
  const msg = { v: 1, type: 'browser', tabId, command }
  return sendPipeMessage(pipeName, msg as unknown as PipeMessage, timeoutMs) as Promise<Reply>
}
