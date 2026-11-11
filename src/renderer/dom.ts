export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}

/** a settings section: its title, a note beside it, and its fields */
export function section(title: string, note: string | null, ...content: HTMLElement[]): HTMLElement {
  const h = el('h2', { className: 'section-title' }, title, ...(note ? [el('span', { className: 'section-note', textContent: note })] : []))
  return el('section', {}, h, ...content)
}

/**
 * Loads every face of the bundled Inter the page can use. Inter is split by script, and a face that is not loaded yet swaps in
 * only once text needs it, so the text would show in the fallback font until then. A face that fails leaves that fallback, never
 * a blank window.
 */
export function loadInter(): Promise<void> {
  return Promise.all([...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Inter Variable').map((f) => f.load().catch(() => {}))).then(() => {})
}
