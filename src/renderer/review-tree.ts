/** a file of the view: its index in the view's files */
export interface TreeFile {
  kind: 'file'
  name: string
  index: number
}

/** a folder; `name` may join a chain of folders that hold only one folder each ("src/main"), `path` is its full path */
export interface TreeDir {
  kind: 'dir'
  name: string
  path: string
  children: TreeNode[]
}

export type TreeNode = TreeDir | TreeFile

interface Building {
  dirs: Map<string, Building>
  files: TreeFile[]
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)

function toNodes(b: Building, parent: string): TreeNode[] {
  const dirs = [...b.dirs].map(([name, child]): TreeDir => {
    let path = parent ? `${parent}/${name}` : name
    let label = name
    let node = child
    // a folder that holds one folder and nothing else shares its row
    while (node.files.length === 0 && node.dirs.size === 1) {
      const [[next, inner]] = [...node.dirs]
      label = `${label}/${next}`
      path = `${path}/${next}`
      node = inner!
    }
    return { kind: 'dir', name: label, path, children: toNodes(node, path) }
  })
  return [...dirs.sort(byName), ...[...b.files].sort(byName)]
}

/** The files at `indices` of the view as a tree of folders: folders first, then files, each by name; `/` and `\` both separate. */
export function buildTree(files: readonly { relPath: string }[], indices: readonly number[]): TreeNode[] {
  const root: Building = { dirs: new Map(), files: [] }
  for (const index of indices) {
    const parts = files[index]!.relPath.split(/[\\/]+/).filter((p) => p !== '')
    const name = parts.pop() ?? files[index]!.relPath
    let at = root
    for (const part of parts) {
      let next = at.dirs.get(part)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        at.dirs.set(part, next)
      }
      at = next
    }
    at.files.push({ kind: 'file', name, index })
  }
  return toNodes(root, '')
}

/** the files' indices from the top of the tree down: the order the diffs are shown in */
export function treeOrder(nodes: readonly TreeNode[]): number[] {
  return nodes.flatMap((n) => (n.kind === 'file' ? [n.index] : treeOrder(n.children)))
}

/** the indices of the files whose path holds the text, in any case; all of them for no text */
export function filterFiles(files: readonly { relPath: string }[], text: string): number[] {
  const q = text.trim().toLowerCase()
  return files.flatMap((f, i) => (q === '' || f.relPath.toLowerCase().includes(q) ? [i] : []))
}
