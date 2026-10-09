import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { fillTemplate, launchEditor, revealInFolder, splitCommand } from '../../src/main/editor-launch'

function child(fail?: Error) {
  const c = Object.assign(new EventEmitter(), { unref: vi.fn() })
  if (fail) queueMicrotask(() => c.emit('error', fail))
  return c
}

describe('splitCommand', () => {
  it('splits on spaces and keeps quoted parts together', () => {
    expect(splitCommand('code --goto {file}:{line}')).toEqual(['code', '--goto', '{file}:{line}'])
    expect(splitCommand('"C:\\Program Files\\JetBrains\\Rider\\bin\\rider64.exe" --line {line} "{file}"'))
      .toEqual(['C:\\Program Files\\JetBrains\\Rider\\bin\\rider64.exe', '--line', '{line}', '{file}'])
    expect(splitCommand('   ')).toEqual([])
    expect(splitCommand('a ""')).toEqual(['a', ''])
  })
})

describe('fillTemplate', () => {
  it('puts the file and the line into every argument', () => {
    expect(fillTemplate(['--goto', '{file}:{line}', '{line}'], 'D:\\p\\a b.ts', 7)).toEqual(['--goto', 'D:\\p\\a b.ts:7', '7'])
  })

  it('takes $ sequences in a path literally', () => {
    expect(fillTemplate(['{file}:{line}'], "/p/a$&b$$c$'d$`e.ts", 3)).toEqual(["/p/a$&b$$c$'d$`e.ts:3"])
  })
})

describe('launchEditor', () => {
  it('runs the template as a command with arguments', () => {
    const spawn = vi.fn(() => child())
    launchEditor('subl {file}:{line}', '/p/a.ts', 12, { spawn, reveal: vi.fn(), onError: vi.fn() })
    expect(spawn).toHaveBeenCalledWith('subl', ['/p/a.ts:12'])
  })

  it('tries VS Code by default and only shows the file in its folder when code is missing, never runs it', async () => {
    const spawn = vi.fn(() => child(new Error('spawn code ENOENT')))
    const reveal = vi.fn()
    const onError = vi.fn()
    launchEditor(null, '/p/deploy.bat', 3, { spawn, reveal, onError })
    expect(spawn).toHaveBeenCalledWith('code', ['--goto', '/p/deploy.bat:3'])
    await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith('/p/deploy.bat'))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('VS Code was not found: set review.editor to open files in your editor')
  })

  it('reports an editor that does not start, and an empty template', async () => {
    const onError = vi.fn()
    const reveal = vi.fn()
    launchEditor('subl {file}', '/p/a.ts', 1, { spawn: () => child(new Error('spawn subl ENOENT')), reveal, onError })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Cannot start the editor (subl): spawn subl ENOENT'))
    expect(reveal).not.toHaveBeenCalled()
    launchEditor('  ', '/p/a.ts', 1, { spawn: vi.fn(), reveal, onError })
    expect(onError).toHaveBeenLastCalledWith('review.editor is empty')
  })
})

describe('revealInFolder', () => {
  const deps = (files: string[], dirs: string[]) => ({
    exists: (p: string) => files.includes(p),
    isDirectory: (p: string) => dirs.includes(p),
    showItem: vi.fn(),
    openFolder: vi.fn()
  })

  it('shows an existing file selected in its folder', () => {
    const d = deps(['/p/src/a.ts'], ['/p/src'])
    revealInFolder('/p/src/a.ts', d)
    expect(d.showItem).toHaveBeenCalledWith('/p/src/a.ts')
    expect(d.openFolder).not.toHaveBeenCalled()
  })

  it('opens the folder of a file that is gone, never the file', () => {
    const d = deps([], ['/p/src'])
    revealInFolder('/p/src/gone.ts', d)
    expect(d.openFolder).toHaveBeenCalledWith('/p/src')
    expect(d.showItem).not.toHaveBeenCalled()
  })

  it('does nothing when the folder is gone too', () => {
    const d = deps([], [])
    revealInFolder('/p/src/gone.ts', d)
    expect(d.openFolder).not.toHaveBeenCalled()
    expect(d.showItem).not.toHaveBeenCalled()
  })
})
