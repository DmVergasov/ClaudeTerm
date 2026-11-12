import type { ChatModelInfo } from '../../shared/chat'

/** the models are asked for again this many times, this far apart, while the picker is open and the answer is empty */
const ASK_ATTEMPTS = 30
const ASK_GAP_MS = 300

export interface ModelPickerOptions {
  models(): Promise<ChatModelInfo[]>
  /** the chat's model and effort as the chat has them now */
  current(): { model: string | null; effort: string | null }
  /** Apply: the session takes the model, and the effort (null: none) */
  apply(model: string, effort: string | null): void
  /** the focus goes back to the field: after Apply or Cancel, and when Esc closes the picker */
  refocus(): void
}

/**
 * The list's entry for the chat's model: the one whose value is the model, else the one whose resolved id is (the stream names
 * the full id, the list the aliases). Of several entries that resolve to it, one that is not `default` wins: `default` names
 * the same model as its alias.
 */
export function findModel(list: ChatModelInfo[], model: string | null): ChatModelInfo | undefined {
  if (model === null) return undefined
  const byValue = list.find((m) => m.value === model)
  if (byValue !== undefined) return byValue
  const byResolved = list.filter((m) => m.resolved === model)
  return byResolved.find((m) => m.value !== 'default') ?? byResolved[0]
}

/** the effort a model takes: the one the session has when the model has it, else none (the model's own default) */
function effortFor(model: ChatModelInfo | undefined, wanted: string | null): string | null {
  const levels = model?.efforts ?? []
  if (wanted !== null && levels.includes(wanted)) return wanted
  return null
}

/**
 * The /model picker above the model chip: the session's models with their descriptions, the current one checked, the effort
 * row of the chosen model (hidden when it has none), and Cancel and Apply. Esc closes it.
 */
export class ModelPicker {
  readonly element: HTMLDivElement
  private models: ChatModelInfo[] = []
  private picked: string | null = null
  private effort: string | null = null
  private opened = false
  /** each open starts a new round of asks: the rounds of earlier opens stop */
  private generation = 0
  /** the picker is being drawn again: the focus leaves the buttons it removes, and that is not the picker closing */
  redrawing = false

  constructor(private readonly o: ModelPickerOptions) {
    this.element = document.createElement('div')
    this.element.className = 'chat-model-picker'
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', 'Model')
    // a press keeps the focus where it was: a redraw of the picker must not take the focus with it, which would close it
    this.element.addEventListener('mousedown', (e) => e.preventDefault())
    // Esc on a focused button of the picker closes it too, as Esc in the field does
    this.element.addEventListener('keydown', (e) => {
      if (!this.key(e)) return
      e.preventDefault()
      this.o.refocus()
    })
  }

  /** shows the picker over the anchor's field, with the chat's current model checked */
  open(anchor: HTMLElement): void {
    const host = anchor.closest<HTMLElement>('.chat-field') ?? anchor.parentElement ?? anchor
    if (this.element.parentElement !== host) host.append(this.element)
    const current = this.o.current()
    this.picked = current.model
    this.effort = current.effort
    this.opened = true
    this.generation++
    this.element.hidden = false
    this.render()
    this.ask(0, this.generation)
  }

  /**
   * The models are asked for while the picker is open. An answer with none is not the list yet (the chat's list comes when
   * Claude Code has started): it is asked for again, a few times, while the picker stays open. A round of asks that an
   * open or a close has overtaken asks no more.
   */
  private ask(attempt: number, round: number): void {
    if (round !== this.generation || !this.opened) return
    void this.o.models().then((list) => {
      if (round !== this.generation || !this.opened) return
      if (list.length > 0) {
        this.models = list
        // the chat's model is checked as the entry it is: the stream's full id is the alias's entry
        const found = findModel(list, this.picked)
        if (found !== undefined) this.picked = found.value
        this.effort = effortFor(found, this.effort)
        this.render()
        return
      }
      if (attempt < ASK_ATTEMPTS) setTimeout(() => this.ask(attempt + 1, round), ASK_GAP_MS)
    }, () => undefined)
  }

  /** whether the picker is open: the model chip's click closes an open picker, and opens a closed one */
  get isOpen(): boolean {
    return this.opened
  }

  close(): void {
    this.opened = false
    this.element.hidden = true
  }

  /** Esc closes the open picker; true when it took the key */
  key(e: KeyboardEvent): boolean {
    if (!this.opened || e.key !== 'Escape') return false
    this.close()
    return true
  }

  private pick(model: string): void {
    this.picked = model
    this.effort = effortFor(this.models.find((m) => m.value === model), this.effort)
    this.render()
  }

  private apply(): void {
    if (this.picked === null) return
    this.o.apply(this.picked, effortFor(this.models.find((m) => m.value === this.picked), this.effort))
    this.close()
    this.o.refocus()
  }

  private render(): void {
    // the buttons are drawn again: the focus goes back to the one it was on, so a key press does not lose the picker
    const focused = this.element.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focus ?? null : null
    const head = document.createElement('div')
    head.className = 'chat-model-head'
    const title = document.createElement('span')
    title.className = 'chat-model-title'
    title.textContent = 'Model'
    const scope = document.createElement('span')
    scope.className = 'chat-model-scope'
    scope.textContent = 'for this session'
    head.append(title, scope)

    const options = document.createElement('div')
    options.className = 'chat-model-options'
    for (const model of this.models) {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = 'chat-model-option'
      option.dataset.focus = `model:${model.value}`
      option.setAttribute('aria-pressed', String(model.value === this.picked))
      const text = document.createElement('span')
      text.className = 'chat-model-text'
      const name = document.createElement('span')
      name.className = 'chat-model-name'
      name.textContent = model.displayName
      const desc = document.createElement('span')
      desc.className = 'chat-model-desc'
      desc.textContent = model.description
      text.append(name, desc)
      option.append(text)
      option.addEventListener('click', () => this.pick(model.value))
      options.append(option)
    }
    if (this.models.length === 0) {
      const none = document.createElement('div')
      none.className = 'chat-model-desc'
      none.textContent = 'Loading…'
      options.append(none)
    }

    const picked = this.models.find((m) => m.value === this.picked)
    const effort = document.createElement('div')
    effort.className = 'chat-model-effort'
    effort.hidden = (picked?.efforts ?? []).length === 0
    const label = document.createElement('span')
    label.className = 'chat-model-effort-label'
    label.textContent = 'Effort'
    const levels = document.createElement('div')
    levels.className = 'chat-model-levels'
    for (const level of picked?.efforts ?? []) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = level
      button.dataset.focus = `effort:${level}`
      button.setAttribute('aria-pressed', String(level === this.effort))
      button.addEventListener('click', () => {
        this.effort = level
        this.render()
      })
      levels.append(button)
    }
    effort.append(label, levels)

    const foot = document.createElement('div')
    foot.className = 'chat-model-foot'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'chat-model-cancel'
    cancel.textContent = 'Cancel'
    cancel.dataset.focus = 'cancel'
    cancel.addEventListener('click', () => {
      this.close()
      this.o.refocus()
    })
    const apply = document.createElement('button')
    apply.type = 'button'
    apply.className = 'chat-model-apply'
    apply.textContent = 'Apply'
    apply.dataset.focus = 'apply'
    apply.disabled = this.picked === null
    apply.addEventListener('click', () => this.apply())
    foot.append(cancel, apply)

    this.redrawing = true
    this.element.replaceChildren(head, options, effort, foot)
    this.redrawing = false
    if (focused !== null) {
      const again = Array.from(this.element.querySelectorAll<HTMLElement>('[data-focus]')).find((n) => n.dataset.focus === focused)
      if (again && !again.hasAttribute('disabled')) again.focus()
    }
  }
}
