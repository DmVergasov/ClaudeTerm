import { describe, expect, it, vi } from 'vitest'
import { execGit, GitError } from '../../src/main/git-source'

// a process that cannot start a worker thread (out of memory, a broken install)
vi.mock('node:worker_threads', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:worker_threads')>()
  class Worker {
    constructor() {
      throw new Error('ERR_WORKER_INIT_FAILED')
    }
  }
  return { ...real, default: { ...real, Worker }, Worker }
})

describe('the program starter without a worker thread', () => {
  it('git fails as a GitError, which the Changes panel and the tab places expect', async () => {
    const e = await execGit(['--version'], process.cwd()).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(GitError)
    expect((e as Error).message).toContain('ERR_WORKER_INIT_FAILED')
  })
})
