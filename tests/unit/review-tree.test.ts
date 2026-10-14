import { describe, expect, it } from 'vitest'
import { buildTree, filterFiles, treeOrder, type TreeNode } from '../../src/renderer/review-tree'

const files = (...paths: string[]) => paths.map((relPath) => ({ relPath }))

/** the tree as lines: a folder ends with /, children are indented */
function lines(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) => (n.kind === 'dir' ? [`${'  '.repeat(depth)}${n.name}/`, ...lines(n.children, depth + 1)] : [`${'  '.repeat(depth)}${n.name}`]))
}

describe('buildTree', () => {
  it('puts the files in their folders, folders before files, each by name', () => {
    const f = files('top.ts', 'src/b.ts', 'docs/readme.md', 'src/a.ts', 'src/ui/view.ts', 'Alpha.md')
    expect(lines(buildTree(f, [0, 1, 2, 3, 4, 5]))).toEqual([
      'docs/', '  readme.md',
      'src/', '  ui/', '    view.ts', '  a.ts', '  b.ts',
      'Alpha.md', 'top.ts'
    ])
  })

  it('joins a chain of folders that hold only one folder each into one row', () => {
    const f = files('src/main/a.ts', 'src/main/b.ts', 'tests/e2e/deep/x.spec.ts', 'src/renderer/c.ts')
    expect(lines(buildTree(f, [0, 1, 2, 3]))).toEqual([
      'src/', '  main/', '    a.ts', '    b.ts', '  renderer/', '    c.ts',
      'tests/e2e/deep/', '  x.spec.ts'
    ])
  })

  it('gives each folder its full path, the key of its folded state', () => {
    const [src, tests] = buildTree(files('src/main/a.ts', 'src/ui/b.ts', 'tests/e2e/c.ts'), [0, 1, 2])
    expect(src!.kind === 'dir' && [src.path, src.children.map((c) => c.kind === 'dir' && c.path)]).toEqual(['src', ['src/main', 'src/ui']])
    expect(tests!.kind === 'dir' && tests.path).toBe('tests/e2e')
  })

  it('takes \\ as a separator too: the path of a file outside the folder is a full one', () => {
    expect(lines(buildTree(files('C:\\work\\lib\\a.ts', 'C:\\work\\lib\\b.ts'), [0, 1]))).toEqual(['C:/work/lib/', '  a.ts', '  b.ts'])
  })

  it('lists only the files asked for, by their index in the view', () => {
    const tree = buildTree(files('src/a.ts', 'docs/b.md', 'src/c.ts'), [2, 0])
    expect(lines(tree)).toEqual(['src/', '  a.ts', '  c.ts'])
    expect(treeOrder(tree)).toEqual([0, 2])
  })
})

describe('treeOrder', () => {
  it('is the order of the files from the top of the tree down', () => {
    const f = files('top.ts', 'src/b.ts', 'docs/readme.md', 'src/a.ts', 'src/ui/view.ts')
    expect(treeOrder(buildTree(f, [0, 1, 2, 3, 4]))).toEqual([2, 4, 3, 1, 0])
  })
})

describe('filterFiles', () => {
  it('keeps the files whose path holds the text, in any case; no text keeps them all', () => {
    const f = files('src/main/updater.ts', 'tests/e2e/update.spec.ts', 'README.md')
    expect(filterFiles(f, 'UPD')).toEqual([0, 1])
    expect(filterFiles(f, 'e2e/')).toEqual([1])
    expect(filterFiles(f, '  ')).toEqual([0, 1, 2])
    expect(filterFiles(f, 'nothing')).toEqual([])
  })
})
