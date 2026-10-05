// Stand-in for `claude` in README screenshots: prints a demo conversation and stays alive.
// Claude tabs run it as `node demo-claude.mjs --settings <file>` from the tab's folder.
import { basename } from 'node:path'

const sgr = (code) => `\x1b[${code}m`
const reset = sgr(0)
const dim = sgr('38;2;128;128;138')
const text = sgr('38;2;214;214;214')
const accent = sgr('38;2;217;119;87')
const green = sgr('38;2;120;190;130')
const blue = sgr('38;2;120;165;230')
const bold = sgr(1)

const tool = (name, arg) => `${green}●${reset} ${bold}${text}${name}${reset}${dim}(${arg})${reset}`
const result = (line) => `  ${dim}⎿  ${line}${reset}`
const more = (line) => `     ${dim}${line}${reset}`
const say = (line) => `${text}${line}${reset}`

const conversations = {
  'acme-dashboard': [
    '',
    `${dim}>${reset} ${text}Plot monthly revenue for 2026 and compare it with last year${reset}`,
    '',
    `${accent}●${reset} ${say("I'll read the sales export, render both charts and double-check the totals.")}`,
    '',
    tool('Read', 'data/sales-2026.csv'),
    result('Read 1,284 lines'),
    '',
    tool('Bash', 'python scripts/plot_revenue.py --year 2026 --compare 2025'),
    result('Saved out/revenue-2026.png'),
    more('Saved out/revenue-yoy.png'),
    '',
    tool('Task', 'Find other revenue reports in the repo'),
    result(`${blue}3 agents running…${reset}`),
    '',
    tool('show_image', 'q3-regions.png, "Q3 revenue by region"'),
    result('Shown in ClaudeTerm'),
    '',
    `${accent}●${reset} ${say('Both charts are in the image panel on the right. Revenue is up 18% year over')}`,
    `  ${say('year, with the strongest growth in July–September; North America leads Q3.')}`,
    '',
    `${dim}>${reset} `
  ],
  'api-server': ['', `${dim}>${reset} ${text}Add rate limiting to the /export endpoint${reset}`, '', `${accent}●${reset} ${say('Looking at the middleware stack…')}`]
}

const folder = basename(process.cwd())
const lines = conversations[folder] ?? conversations['api-server']
// OSC 0 sets the tab title (the shell set it to its own path); no trailing newline keeps the cursor on the prompt
process.stdout.write(`\x1b]0;${folder}\x07` + lines.join('\r\n'))
setInterval(() => {}, 1 << 30)
