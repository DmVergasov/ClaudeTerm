// Prints a version's section of CHANGELOG.md, the notes of its GitHub release: node scripts/release-notes.mjs 0.1.7
// Fails when the section is missing or empty, so a release cannot go out without notes.
import { readFileSync } from 'node:fs'

const version = process.argv[2]
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>')
  process.exit(1)
}
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/)
const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `))
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section`)
  process.exit(1)
}
const next = lines.findIndex((l, i) => i > start && l.startsWith('## '))
const body = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim()
if (!body) {
  console.error(`the "## ${version}" section of CHANGELOG.md is empty`)
  process.exit(1)
}
process.stdout.write(`${body}\n`)
