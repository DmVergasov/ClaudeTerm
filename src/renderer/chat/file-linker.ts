import { MAX_FILE_LINKS, type FileLink } from '../../shared/chat-paths'

/** how long a text must stand still before its paths are asked about: a streamed answer is asked once it pauses */
export const ASK_DELAY_MS = 250

/**
 * The pending paths of Claude's text (the chat-path elements) that main says are files of the tab, turned into links. The
 * window asks main once a text settles, in batches of at most MAX_FILE_LINKS distinct paths; each answer is kept by its path
 * text, so a path that appears again is not asked again. A path that is not a file stays text (data-link="none").
 */
export class FileLinker {
  /** the answer to each path text asked: the link, or null when it is not a file */
  private readonly known = new Map<string, FileLink | null>()
  /** the path texts of the calls that have not answered yet */
  private readonly inFlight = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(private readonly root: HTMLElement, private readonly resolve: (paths: string[]) => Promise<FileLink[]>) {}

  /** the text changed: the paths are asked about once it has stood still for ASK_DELAY_MS */
  scan(): void {
    if (this.disposed) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.ask()
    }, ASK_DELAY_MS)
  }

  /** Claude's turn ended: the files it named may be written now, so the paths that were not files are asked again */
  recheck(): void {
    if (this.disposed) return
    for (const [path, link] of [...this.known]) if (link === null) this.known.delete(path)
    for (const node of this.root.querySelectorAll<HTMLElement>('.chat-path[data-link="none"]')) delete node.dataset.link
    this.scan()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** applies the answers kept to the paths in the column, then asks main about the paths nobody asked yet */
  private ask(): void {
    if (this.disposed) return
    const nodes = [...this.root.querySelectorAll<HTMLElement>('.chat-path')]
    for (const node of nodes) {
      if (node.dataset.link === 'file' || node.dataset.link === 'none') continue
      const answer = this.known.get(node.dataset.path ?? '')
      if (answer !== undefined) this.apply(node, answer)
    }
    const batch = new Set<string>()
    for (const node of nodes) {
      if (node.dataset.link !== undefined) continue
      const path = node.dataset.path ?? ''
      if (this.inFlight.has(path)) node.dataset.link = 'asked'
      else if (batch.has(path) || batch.size < MAX_FILE_LINKS) {
        batch.add(path)
        node.dataset.link = 'asked'
      }
    }
    if (batch.size === 0) return
    const paths = [...batch]
    for (const path of paths) this.inFlight.add(path)
    this.resolve(paths).then(
      (links) => {
        if (this.disposed) return
        const byPath = new Map(links.map((link) => [link.path, link]))
        for (const path of paths) {
          this.inFlight.delete(path)
          this.known.set(path, byPath.get(path) ?? null)
        }
        this.ask()
      },
      () => {
        if (this.disposed) return
        // a failed call caches nothing: its paths are text for now, and the next recheck asks them again
        for (const path of paths) this.inFlight.delete(path)
        for (const node of this.root.querySelectorAll<HTMLElement>('.chat-path[data-link="asked"]')) {
          if (paths.includes(node.dataset.path ?? '')) node.dataset.link = 'none'
        }
      }
    )
  }

  /** a path is a link to its file, or text (none) */
  private apply(node: HTMLElement, link: FileLink | null): void {
    if (link === null) {
      node.dataset.link = 'none'
      return
    }
    node.dataset.link = 'file'
    node.classList.add('chat-file-link')
    node.dataset.file = link.file
    if (link.line !== null) node.dataset.line = String(link.line)
    const where = link.line === null ? link.file : `${link.file}:${link.line}`
    node.title = link.kind === 'doc' ? `Open ${link.file} in Docs` : `Open ${where} in the editor`
  }
}
