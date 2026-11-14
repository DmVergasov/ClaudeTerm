import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loginEnv } from '../../src/main/accounts'
import { ensureMcpRegistered, execRunner } from '../../src/main/mcp-registrar'
import { installFakeClaude } from '../fixtures/fake-claude/install'

// ensureMcpRegistered for an extra account: the stand-in Claude Code (tests/fixtures/fake-claude) installed as claude,
// run by the real child-process runner, so the account's CLAUDE_CONFIG_DIR is the folder it writes into

const WIN = process.platform === 'win32'
const EXE = WIN ? 'C:\\invented\\ClaudeTerm\\ClaudeTerm.exe' : '/invented/ClaudeTerm/ClaudeTerm'
const SCRIPT = WIN ? 'C:\\invented\\ClaudeTerm\\resources\\mcp\\show-image-server.js' : '/invented/ClaudeTerm/resources/mcp/show-image-server.js'

let dir: string
let acc: string
const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ct-mcpreg-')))
  acc = join(dir, 'accounts', 'work')
  mkdirSync(acc, { recursive: true })
  // the stand-in falls back to the home folder's .claude when no account folder is given: a test never reaches the real one
  process.env.HOME = join(dir, 'home')
  process.env.USERPROFILE = join(dir, 'home')
})

afterEach(() => {
  for (const key of ['HOME', 'USERPROFILE'] as const) {
    if (home[key] === undefined) delete process.env[key]
    else process.env[key] = home[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('ensureMcpRegistered through the stand-in', () => {
  it("ensureMcpRegistered registers claudeterm in an account's folder through the stand-in", async () => {
    const claude = installFakeClaude(join(dir, 'bin'))
    const logs: string[] = []
    const options = { run: execRunner, execPath: EXE, serverScript: SCRIPT, log: (m: string) => logs.push(m), resolve: async () => ({ file: claude, viaCmd: WIN }), env: loginEnv(acc) }

    expect(await ensureMcpRegistered(options)).toBe('registered')
    const doc = JSON.parse(readFileSync(join(acc, '.claude.json'), 'utf8'))
    expect(doc.mcpServers.claudeterm.command).toBe(EXE)

    expect(await ensureMcpRegistered(options)).toBe('already')
    expect(logs).toEqual([])
  })
})
