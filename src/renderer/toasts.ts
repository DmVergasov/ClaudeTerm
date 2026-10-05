export function showToast(message: string, timeoutMs = 6000): void {
  const host = document.getElementById('toasts')
  if (!host) return
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = message
  el.addEventListener('click', () => el.remove())
  host.append(el)
  setTimeout(() => el.remove(), timeoutMs)
}
