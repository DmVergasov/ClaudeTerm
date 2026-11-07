import { describe, expect, it } from 'vitest'
import { sendFiles, type OutgoingFile } from '../../src/main/sync/file-sender'
import type { RemoteActions } from '../../src/main/sync/remote-actions'
import type { CallArgs, CallReplies } from '../../src/main/sync/remote-shapes'

const TAB = 'd1000000-0000-4000-8000-000000000001'
const TRANSFER = 'e1000000-0000-4000-8000-000000000001'

/** a fake of the calls to the tab's device: recv-end answers `end`, the other calls answer what they need */
function fakeActions(end: CallReplies['recv-end']): { actions: RemoteActions; ends: CallArgs['recv-end'][] } {
  const ends: CallArgs['recv-end'][] = []
  const actions = {
    askTab: async (_tabId: string, method: string, args: unknown) => {
      if (method === 'recv-begin') return { transfer: TRANSFER }
      if (method === 'recv-end') {
        ends.push(args as CallArgs['recv-end'])
        return end
      }
      return {}
    }
  } as unknown as RemoteActions
  return { actions, ends }
}

const oneFile: OutgoingFile = { name: 'a.png', size: 0, read: async () => Buffer.alloc(0) }

describe('sendFiles', () => {
  it('asks recv-end with the tab id, and types the text the tab answers, unchanged', async () => {
    const { actions, ends } = fakeActions({ paths: ['/r/a.png'], text: "'/r/a.png'" })
    expect(await sendFiles(actions, TAB, [oneFile])).toEqual({ paths: ['/r/a.png'], text: "'/r/a.png'" })
    expect(ends).toEqual([{ transfer: TRANSFER, id: TAB }])
  })

  it('an older device that answers the paths alone is typed as double-quoted paths, as 0.15.0 did', async () => {
    const { actions } = fakeActions({ paths: ['/r/a b.png', '/r/c.txt'] })
    expect(await sendFiles(actions, TAB, [oneFile, oneFile])).toEqual({
      paths: ['/r/a b.png', '/r/c.txt'],
      text: '"/r/a b.png" "/r/c.txt"'
    })
  })
})
