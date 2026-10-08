import type { CtApi } from '../shared/ipc'

export interface CtTestHook {
  activeTabId(): string | null
  tabIds(): string[]
  tabTitle(id: string): string | null
  bufferText(id?: string): string
  /** everything written to a tab's terminal input (test runs) */
  ptyInput?(id?: string): string
  images?(id?: string): { name: string; source: string; caption: string | null }[]
  restoreVisible?(): boolean
  /** the active terminal's theme background */
  themeBackground?(): string | null
}

declare global {
  interface Window {
    ct: CtApi
    __ct?: CtTestHook
  }
}

export {}
