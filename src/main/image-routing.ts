export interface FolderTab {
  tabId: string
  toolRunningAt(t: number): boolean
}

/**
 * Whether a new image in a Claude tab's folder goes to that tab. `sameFolder` is every Claude tab watching the
 * folder, this one included. With several, the image goes to those whose Claude was running a tool (its own or a
 * subagent's) when the file was written; when none was, a dev server or the user wrote it, and all of them get it.
 */
export function folderImageGoesTo(tabId: string, sameFolder: FolderTab[], writtenAt: number): boolean {
  if (sameFolder.length <= 1) return true
  const writers = sameFolder.filter((t) => t.toolRunningAt(writtenAt))
  return writers.length === 0 || writers.some((t) => t.tabId === tabId)
}
