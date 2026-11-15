// The coordinator's dialogs: a modal in the MCP Add dialog's style, for a question with one action or a form with one

import { el } from './dom'

export interface DialogOptions {
  /** the card's data-dialog, for the tests and the styles */
  id: string
  title: string
  body: HTMLElement[]
  /** the primary button's label; null: the dialog has Cancel only */
  action: string | null
  /** the primary button, Enter in an input, Ctrl/Cmd+Enter in a textarea: answers the error to show, or null to close */
  submit?: () => Promise<string | null>
  /** whether the primary button is enabled now: asked on every input event inside the dialog */
  ready?: () => boolean
  /** the dialog closed, by any way */
  closed?: () => void
}

export interface DialogHandle {
  close(): void
  error(text: string): void
  busy(on: boolean, label?: string): void
}

/** a modal in the MCP Add dialog's style, on document.body; its keys stay in it, Escape and a click on the scrim close it */
export function openDialog(o: DialogOptions): DialogHandle {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let closed = false
  let busyNow = false
  let busyLabel: string | undefined
  const closeButton = el('button', { className: 'mcp-ghost', type: 'button', textContent: '✕' })
  closeButton.setAttribute('aria-label', 'Close')
  const cancel = el('button', { className: 'mcp-btn ghost', type: 'button', textContent: 'Cancel' })
  const action = o.action === null ? null : el('button', { className: 'mcp-btn primary', type: 'button', textContent: o.action })
  const errorBox = el('div', { className: 'mcp-add-error' })

  const title = el('h2', { className: 'mcp-add-title', id: 'coord-dialog-title', textContent: o.title })
  const dialog = el('div', { className: 'mcp-add coord-dialog' },
    el('div', { className: 'mcp-add-head' }, title, closeButton),
    el('div', { className: 'mcp-add-body' }, ...o.body),
    el('div', { className: 'mcp-add-bottom' }, el('div', { className: 'mcp-add-actions' }, cancel, ...(action ? [action] : [])), errorBox))
  dialog.dataset.dialog = o.id
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'coord-dialog-title')
  const scrim = el('div', { className: 'mcp-add-scrim' }, dialog)

  function close(): void {
    if (closed) return
    closed = true
    scrim.remove()
    if (opener?.isConnected) opener.focus()
    o.closed?.()
  }

  // while an answer is on its way both buttons are off; the primary one is also off until the form is ready
  function paint(): void {
    cancel.disabled = busyNow
    if (!action) return
    action.disabled = busyNow || (o.ready !== undefined && !o.ready())
    action.textContent = busyNow && busyLabel !== undefined ? busyLabel : (o.action ?? '')
  }

  function busy(on: boolean, label?: string): void {
    if (closed) return
    busyNow = on
    busyLabel = on ? label : undefined
    paint()
  }

  function error(text: string): void {
    if (!closed) errorBox.textContent = text
  }

  async function submitNow(): Promise<void> {
    if (closed || busyNow || (o.ready !== undefined && !o.ready())) return
    if (!o.submit) {
      close()
      return
    }
    error('')
    busy(true)
    let answer: string | null
    try {
      answer = await o.submit()
    } catch (e) {
      answer = String(e)
    }
    if (closed) return
    busy(false)
    if (answer === null) close()
    else error(answer)
  }

  closeButton.addEventListener('click', close)
  cancel.addEventListener('click', close)
  action?.addEventListener('click', () => void submitNow())
  dialog.addEventListener('input', paint)
  // Esc closes; Tab stays inside the dialog; the keys never reach the app behind it
  scrim.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Enter' && (e.target instanceof HTMLInputElement || ((e.ctrlKey || e.metaKey) && e.target instanceof HTMLTextAreaElement))) {
      e.preventDefault()
      void submitNow()
      return
    }
    if (e.key !== 'Tab') return
    const stops = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, textarea'))
      .filter((n) => !n.hasAttribute('disabled') && n.tabIndex >= 0 && n.getClientRects().length > 0)
    if (stops.length === 0) return
    const first = stops[0]
    const last = stops[stops.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault()
      first.focus()
    }
  })
  // a press on the scrim itself, outside the dialog, closes it
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close()
  })

  paint()
  document.body.append(scrim)
  const focus = dialog.querySelector<HTMLElement>('.mcp-add-body input, .mcp-add-body textarea') ?? action ?? cancel
  focus.focus()
  return { close, error, busy }
}

/** a yes/no question in that style: true when its action was clicked */
export function confirmDialog(o: { id: string; title: string; text: string; action: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false
    openDialog({
      id: o.id,
      title: o.title,
      body: [el('div', { className: 'coord-dialog-text', textContent: o.text })],
      action: o.action,
      submit: async () => {
        answer = true
        return null
      },
      closed: () => resolve(answer)
    })
  })
}
