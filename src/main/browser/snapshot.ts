/** One value of a CDP accessibility node: a role, a name, a property or a value */
export interface AXValue { type?: string; value?: unknown }

/** One node of CDP `Accessibility.getFullAXTree` */
export interface AXNode {
  nodeId: string
  ignored: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: { name: string; value: AXValue }[]
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

export interface Snapshot {
  text: string
  /** `e1`, `e2`, … to the backend DOM node id of each printed element */
  refs: Map<string, number>
  truncated: boolean
}

export const SNAPSHOT_LIMIT = 60_000

const NAME_LIMIT = 200
const SKIPPED_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak'])
const FLAGS = ['checked', 'disabled', 'expanded', 'selected']
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox'])

/** the first `max` code points of `text`, the last of them an ellipsis when cut */
export function cutText(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…'
}

function str(v: AXValue | undefined): string {
  return typeof v?.value === 'string' ? v.value : ''
}

/**
 * The page as indented text, one line per printed node, with a ref for each element.
 * Ignored nodes and the roles none, generic, InlineTextBox and LineBreak print nothing;
 * their children print in their place.
 */
export function formatSnapshot(nodes: AXNode[], limit: number = SNAPSHOT_LIMIT): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const root = nodes.find((n) => !n.parentId)
  const lines: string[] = []
  const refs = new Map<string, number>()
  const seen = new Set<string>()
  let length = 0
  let truncated = false

  interface Frame { node: AXNode; depth: number; ancestorName: string | undefined }
  const stack: Frame[] = []
  const pushChildren = (node: AXNode, depth: number, ancestorName: string | undefined): void => {
    const ids = node.childIds ?? []
    for (let i = ids.length - 1; i >= 0; i--) {
      const child = byId.get(ids[i])
      if (child) stack.push({ node: child, depth, ancestorName })
    }
  }
  if (root) pushChildren(root, 0, undefined)

  while (stack.length > 0) {
    const { node, depth, ancestorName } = stack.pop() as Frame
    if (seen.has(node.nodeId)) continue
    seen.add(node.nodeId)

    const role = str(node.role)
    if (node.ignored || SKIPPED_ROLES.has(role)) {
      pushChildren(node, depth, ancestorName)
      continue
    }

    const name = str(node.name)
    let line: string
    let ref: { name: string; id: number } | undefined

    if (role === 'StaticText') {
      if (name === ancestorName) continue
      line = `- text: "${cutText(name, NAME_LIMIT)}"`
    } else {
      line = `- ${role}`
      if (name) line += ` "${cutText(name, NAME_LIMIT)}"`
      for (const flag of FLAGS) {
        if (node.properties?.some((p) => p.name === flag && p.value.value === true)) line += ` [${flag}]`
      }
      const level = node.properties?.find((p) => p.name === 'level')?.value.value
      if (level !== undefined) line += ` [level=${String(level)}]`
      const value = node.value?.value
      if (VALUE_ROLES.has(role) && typeof value === 'string' && value !== '') {
        line += `: "${cutText(value, NAME_LIMIT)}"`
      }
      if (node.backendDOMNodeId !== undefined) {
        ref = { name: `e${refs.size + 1}`, id: node.backendDOMNodeId }
        line += ` [ref=${ref.name}]`
      }
    }

    const indented = `${'  '.repeat(depth)}${line}`
    const next = length + (lines.length > 0 ? 1 : 0) + indented.length
    if (next > limit) {
      truncated = true
      lines.push(`- … (snapshot cut at ${limit} characters; use browser_evaluate or browser_take_screenshot for the rest)`)
      break
    }
    length = next
    lines.push(indented)
    if (ref) refs.set(ref.name, ref.id)
    pushChildren(node, depth + 1, name)
  }

  return { text: lines.join('\n'), refs, truncated }
}
