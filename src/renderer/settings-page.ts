import './settings.css'

const root = document.getElementById('settings')!
const heading = document.createElement('h1')
heading.className = 'settings-heading'
heading.textContent = 'Settings'
root.append(heading)

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close()
})
