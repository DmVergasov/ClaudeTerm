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
