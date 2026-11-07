import { IMAGE_PART_TIMEOUT_MS, MAX_TRANSFER_BYTES, MAX_TRANSFER_FILES, REMOTE_COPY, TRANSFER_PART_BYTES } from '../../shared/remote'
import { CallError } from './calls'
import type { RemoteActions } from './remote-actions'

// The files pasted or dropped on this device, sent to a tab on the device that runs it: recv-begin, then every part of every
// file on the bulk lane one after another, then recv-end, which answers the paths the files were saved at.

/** a file to send: its name, its size, and its bytes from an offset */
export interface OutgoingFile {
  name: string
  size: number
  read(offset: number, length: number): Promise<Buffer>
}

/** the paths the files were saved at on the tab's device, in the order sent; a refusal is the receiver's message */
export async function sendFiles(actions: RemoteActions, tabId: string, files: OutgoingFile[]): Promise<string[]> {
  // refused here, before anything is sent, when the files cannot fit one transfer
  if (files.length > MAX_TRANSFER_FILES) throw new CallError(REMOTE_COPY.copyTooManyFiles)
  if (files.reduce((n, f) => n + f.size, 0) > MAX_TRANSFER_BYTES) throw new CallError(REMOTE_COPY.receiveTooLarge)
  const { transfer } = await actions.askTab(tabId, 'recv-begin', { id: tabId, files: files.map(({ name, size }) => ({ name, size })) })
  for (const [file, f] of files.entries()) {
    for (let offset = 0; offset < f.size; ) {
      const length = Math.min(TRANSFER_PART_BYTES, f.size - offset)
      const data = await readPart(f, offset, length)
      // one part at a time: the next goes when this one is answered; the limit is the one a bulk part of an image has
      await actions.askTab(tabId, 'recv-part', { transfer, file, offset, data: data.toString('base64') }, { bulk: true, timeoutMs: IMAGE_PART_TIMEOUT_MS })
      offset += length
    }
  }
  const { paths } = await actions.askTab(tabId, 'recv-end', { transfer })
  return paths
}

/** the bytes of a part of a file; a file that cannot be read, or gives fewer bytes, fails the copy with no local detail */
async function readPart(f: OutgoingFile, offset: number, length: number): Promise<Buffer> {
  let data: Buffer
  try {
    data = await f.read(offset, length)
  } catch {
    throw new CallError(REMOTE_COPY.copyReadFailed)
  }
  if (data.length !== length) throw new CallError(REMOTE_COPY.copyReadFailed)
  return data
}
