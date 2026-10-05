import type { CtApi } from '../shared/ipc'

export interface CtTestHook {
  activeTabId(): string | null
  tabIds(): string[]
  tabTitle(id: string): string | null
  bufferText(id?: string): string
  images?(id?: string): { name: string; source: string; caption: string | null }[]
  restoreVisible?(): boolean
}

declare global {
  interface Window {
    ct: CtApi
    __ct?: CtTestHook
  }
}

export {}
