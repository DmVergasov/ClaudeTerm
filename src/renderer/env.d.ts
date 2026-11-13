import type { CtApi } from '../shared/ipc'
import type { TabPlace } from '../shared/types'

export interface CtTestHook {
  activeTabId(): string | null
  tabIds(): string[]
  tabTitle(id: string): string | null
  bufferText(id?: string): string
  /** everything written to a tab's terminal input (test runs) */
  ptyInput?(id?: string): string
  /** every size a tab's terminal gave its process, as "colsxrows" (test runs) */
  ptySizes?(id?: string): string[]
  /** the size of a tab's terminal, as its xterm has it (test runs) */
  termSize?(id?: string): { cols: number; rows: number } | null
  images?(id?: string): { name: string; source: string; caption: string | null }[]
  restoreVisible?(): boolean
  /** the active terminal's theme background */
  themeBackground?(): string | null
  /** the system notifications shown, one per tab (test runs keep them instead of showing them) */
  banners?(): { tabId: string; title: string; body: string }[]
  /** a click on the tab's system notification */
  clickBanner?(id: string): void
  /** what Send does with a tab: the refusal's words, or null when the text was sent (test runs) */
  sendText?(id: string, message: string): Promise<string | null>
  /** how many times the window asked the devices for their lists (test runs) */
  choiceAsks?(): number
  /** the attention and unread marks of a tab, null for an unknown tab (test runs) */
  tabMarks?(id: string): { attention: boolean; unread: boolean } | null
  /** the place the window holds for a tab (test runs): undefined until its device has said it */
  placeOf?(id: string): TabPlace | null | undefined
  /** every place event the window got for a tab, in order (test runs): none when no event came, a null place is kept */
  placeEvents?(id: string): (TabPlace | null)[]
  /** the text in the note's editor (test runs) */
  noteText?(): string
}

declare global {
  interface Window {
    ct: CtApi
    __ct?: CtTestHook
  }
}

export {}
