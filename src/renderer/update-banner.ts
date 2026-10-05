import type { UpdateState } from '../shared/types'

/** "A new version is ready" under the tab bar; × hides it for that version only. */
export class UpdateBanner {
  private dismissed: string | null = null

  constructor(private readonly root: HTMLElement, private readonly onInstall: () => void) {}

  update(state: UpdateState): void {
    if (state.status !== 'ready' || state.version === this.dismissed) {
      this.root.hidden = true
      this.root.replaceChildren()
      return
    }
    const version = state.version
    const text = document.createElement('span')
    text.textContent = `ClaudeTerm ${version} is ready to install.`
    const go = document.createElement('button')
    go.className = 'banner-restart'
    go.textContent = 'Restart'
    go.addEventListener('click', () => this.onInstall())
    const close = document.createElement('button')
    close.className = 'banner-close'
    close.textContent = '×'
    close.title = 'Hide'
    close.addEventListener('click', () => {
      this.dismissed = version
      this.update({ status: 'idle' })
    })
    this.root.replaceChildren(text, go, close)
    this.root.hidden = false
  }
}
