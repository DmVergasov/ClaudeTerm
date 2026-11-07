import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { receivedRoot } from '../../src/main/sync/file-receiver'

// The folder the files pasted or dropped into a remote tab are received in: one per user where the temp folder is shared.

describe('the received folder', () => {
  it('Windows: <temp>\\ClaudeTerm\\received, the temp folder being per user already', () => {
    expect(receivedRoot({ platform: 'win32', tmpdir: 'C:\\T', uid: -1 })).toBe(win32.join('C:\\T', 'ClaudeTerm', 'received'))
    expect(receivedRoot({ platform: 'win32', tmpdir: 'C:\\T', uid: -1 })).toBe('C:\\T\\ClaudeTerm\\received')
  })

  it('Linux: <tmp>/ClaudeTerm-<uid>/received, so that each user has a folder of its own in a shared /tmp', () => {
    expect(receivedRoot({ platform: 'linux', tmpdir: '/tmp', uid: 1000 })).toBe(posix.join('/tmp', 'ClaudeTerm-1000', 'received'))
    expect(receivedRoot({ platform: 'linux', tmpdir: '/tmp', uid: 1000 })).toBe('/tmp/ClaudeTerm-1000/received')
    expect(receivedRoot({ platform: 'linux', tmpdir: '/tmp', uid: 1000 })).not.toBe(receivedRoot({ platform: 'linux', tmpdir: '/tmp', uid: 1001 }))
  })

  it('macOS: /tmp/ClaudeTerm-<uid>/received as well', () => {
    expect(receivedRoot({ platform: 'darwin', tmpdir: '/tmp', uid: 501 })).toBe('/tmp/ClaudeTerm-501/received')
  })
})
