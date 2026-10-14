// Prints a version's section of CHANGELOG.md, the notes of its GitHub release: node scripts/release-notes.mjs 0.1.7
// With --updater it prints that section and the nine before it, headings included: the release puts them in
// build/release-notes.md, electron-builder into latest.yml, and an installed copy lists the versions after its own.
// Fails when the section is missing or empty, so a release cannot go out without notes.
import { readFileSync } from 'node:fs'

const UPDATER_SECTIONS = 10

const args = process.argv.slice(2)
const updater = args[0] === '--updater'
const version = updater ? args[1] : args[0]
if (!version) {
  console.error('usage: node scripts/release-notes.mjs [--updater] <version>')
  process.exit(1)
}
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/)
const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `))
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section`)
  process.exit(1)
}
/** where the section starting at `from` ends: the next "## " heading, or the end of the file */
const sectionEnd = (from) => {
  const next = lines.findIndex((l, i) => i > from && l.startsWith('## '))
  return next < 0 ? lines.length : next
}
const body = lines.slice(start + 1, sectionEnd(start)).join('\n').trim()
if (!body) {
  console.error(`the "## ${version}" section of CHANGELOG.md is empty`)
  process.exit(1)
}
if (updater) {
  let end = start
  for (let n = 0; n < UPDATER_SECTIONS && end < lines.length; n++) end = sectionEnd(end)
  process.stdout.write(`${lines.slice(start, end).join('\n').trim()}\n`)
} else {
  process.stdout.write(`${body}\n`)
}
