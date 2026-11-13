import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

// The stand-in Claude Code (tests/fixtures/fake-claude/fake-claude.ts) for the MCP and plugin tests: what it logged, and a CLI
// call of its own. The e2e loader runs specs as CommonJS, so the stand-in's path comes from __dirname, as chat-helpers.ts does

const STAND_IN = resolve(__dirname, '..', 'fixtures', 'fake-claude', 'fake-claude.ts')

/** the session starts the stand-in logged: its argv holds stream-json */
export function chatStarts(log: () => Record<string, unknown>[]): number {
  return log().filter((entry) => Array.isArray(entry.argv) && entry.argv.includes('stream-json')).length
}

/** the `claude mcp …` and `claude plugin …` calls the stand-in logged: the arguments, whether a client secret was in its environment, and the stdin's keys */
export function cliCalls(log: () => Record<string, unknown>[]): { argv: string[]; secretEnv: boolean; stdinKeys: string[] | null }[] {
  return log()
    .filter((entry) => Array.isArray(entry.cli))
    .map((entry) => ({ argv: entry.cli as string[], secretEnv: entry.secretEnv === true, stdinKeys: (entry.stdinKeys ?? null) as string[] | null }))
}

/** a JSON file as the stand-in or Claude Code wrote it; null when it is missing */
export function readJsonFile(file: string): any {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

/**
 * Runs the stand-in as `claude <args>` in `cwd`, with the configuration folder `config` and the script and log that launchChatTab
 * lays out beside it (<dirname(config)>/script.json and fake-claude.log). Returns the exit code and the output.
 */
export function runStandIn(config: string, cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const beside = dirname(config)
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', STAND_IN, ...args], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: config,
      FAKE_CLAUDE_SCRIPT: join(beside, 'script.json'),
      FAKE_CLAUDE_LOG: join(beside, 'fake-claude.log')
    },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true
  })
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}
