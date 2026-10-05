import type { UpdateState } from '../shared/types'

export const FIRST_CHECK_MS = 15_000
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

export interface UpdaterBackend {
  /** resolves the newer version that is being downloaded, or null when this build is the latest */
  check(): Promise<string | null>
  onDownloaded(cb: (version: string) => void): void
  onError(cb: (message: string) => void): void
  quitAndInstall(): void
}

export interface UpdaterDeps {
  /** null: this build cannot update itself (dev, test) */
  backend: UpdaterBackend | null
  currentVersion: string
  /** background checks; read on every tick so a settings change applies without a restart */
  enabled(): boolean
  publish(state: UpdateState): void
  notify(message: string): void
  beforeInstall(): void
  log(message: string): void
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(t: unknown): void
}

/** Background update checks, the messages of a manual check, and the restart into a downloaded update. */
export class Updater {
  private state: UpdateState = { status: 'idle' }
  private checking = false
  private timer: unknown = null

  constructor(private readonly d: UpdaterDeps) {
    d.backend?.onDownloaded((version) => {
      this.state = { status: 'ready', version }
      d.publish(this.state)
    })
    d.backend?.onError((m) => d.log(`update error: ${m}`))
  }

  get current(): UpdateState {
    return this.state
  }

  start(): void {
    if (!this.d.backend) return
    this.schedule(FIRST_CHECK_MS)
  }

  async check(manual: boolean): Promise<void> {
    const b = this.d.backend
    if (!b) {
      if (manual) this.d.notify('Обновления работают только в установленной версии')
      return
    }
    if (this.state.status === 'ready') {
      if (manual) this.d.notify(`ClaudeTerm ${this.state.version} уже загружена — нажмите «Перезапустить»`)
      return
    }
    if (this.checking) return
    this.checking = true
    try {
      const version = await b.check()
      if (manual) this.d.notify(version ? `Загружается ClaudeTerm ${version}…` : `Установлена последняя версия (${this.d.currentVersion})`)
      else if (version) this.d.log(`update ${version} found, downloading`)
    } catch (e) {
      const m = (e as Error).message
      if (manual) this.d.notify(`Не удалось проверить обновления: ${m}`)
      else this.d.log(`update check failed: ${m}`)
    } finally {
      this.checking = false
    }
  }

  install(): void {
    if (this.state.status !== 'ready' || !this.d.backend) return
    this.d.beforeInstall()
    this.d.backend.quitAndInstall()
  }

  stop(): void {
    if (this.timer !== null) (this.d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    const set = this.d.setTimer ?? ((fn: () => void, delay: number) => setTimeout(fn, delay))
    this.timer = set(() => {
      if (this.d.enabled()) void this.check(false)
      this.schedule(CHECK_EVERY_MS)
    }, ms)
  }
}
