import { Calls, type CallEntry } from './calls'
import type { PeerLink } from './peer-link'
import type { TabHost } from './tab-host'
import type { RemoteTabs } from './tab-viewer'
import type { HelloMessage } from './wire'

/**
 * Joins a linked device to this side: the link's one Calls serves the handlers and the host's attach, the host sends
 * this side's tabs to the device, and the viewer shows the device's tabs. Both ends are removed when the link closes.
 */
export function connectPeer(
  link: PeerLink,
  hello: HelloMessage,
  host: TabHost,
  viewer: RemoteTabs,
  handlers: Record<string, CallEntry>
): Calls {
  const calls = new Calls(link, { ...handlers, ...host.handlers(hello.id) })
  host.addPeer(link, hello.id)
  viewer.addPeer(link, hello, calls)
  link.on('close', () => {
    // separate: a throw from close() must not skip removing the device from the viewer
    try {
      calls.close()
    } catch {
      // the link is closed already; nothing more to do with the error
    }
    try {
      viewer.removePeer(link)
    } catch {
      // the device is off the viewer's list either way
    }
  })
  return calls
}
