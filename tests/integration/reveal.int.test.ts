import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { nodeRevealDeps, revealInFolder } from '../../src/main/editor-launch'

describe('revealInFolder on a real folder', () => {
  const setup = () => {
    const showItem = vi.fn()
    const openFolder = vi.fn()
    return { showItem, openFolder, deps: nodeRevealDeps(showItem, openFolder), dir: mkdtempSync(join(tmpdir(), 'ct-reveal-')) }
  }

  it('selects a file that exists', () => {
    const { deps, dir, showItem, openFolder } = setup()
    writeFileSync(join(dir, 'a.ts'), 'x')
    revealInFolder(join(dir, 'a.ts'), deps)
    expect(showItem).toHaveBeenCalledWith(join(dir, 'a.ts'))
    expect(openFolder).not.toHaveBeenCalled()
  })

  it('opens the folder of a deleted file', () => {
    const { deps, dir, showItem, openFolder } = setup()
    mkdirSync(join(dir, 'sub'))
    revealInFolder(join(dir, 'sub', 'gone.ts'), deps)
    expect(openFolder).toHaveBeenCalledWith(join(dir, 'sub'))
    expect(showItem).not.toHaveBeenCalled()
  })

  it('opens nothing when the folder is gone too', () => {
    const { deps, dir, showItem, openFolder } = setup()
    revealInFolder(join(dir, 'nope', 'gone.ts'), deps)
    expect(openFolder).not.toHaveBeenCalled()
    expect(showItem).not.toHaveBeenCalled()
  })

  it('opens nothing when the "folder" of the missing file is a file', () => {
    const { deps, dir, showItem, openFolder } = setup()
    writeFileSync(join(dir, 'plain'), 'x')
    revealInFolder(join(dir, 'plain', 'gone.ts'), deps)
    expect(openFolder).not.toHaveBeenCalled()
    expect(showItem).not.toHaveBeenCalled()
  })
})
