import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatLaunch } from '../../src/main/chat/claude-spawn'
import {
  CHAT_MIN_CLAUDE_VERSION,
  cachedTrustList,
  chatSupport,
  isTrusted,
  trustFile,
  versionBlock,
  type ChatSupportDeps
} from '../../src/main/chat/chat-support'

const direct: ChatLaunch = { how: 'direct', file: '/usr/bin/claude' }

/** a .claude.json text that trusts the given folders, as Claude Code writes it */
function claudeJson(...trusted: string[]): string {
  const projects: Record<string, unknown> = {}
  for (const p of trusted) projects[p] = { hasTrustDialogAccepted: true, allowedTools: [] }
  return JSON.stringify({ numStartups: 4, projects })
}

function deps(over: Partial<ChatSupportDeps> = {}): ChatSupportDeps {
  return {
    version: async () => '2.1.400',
    readTrust: async () => ['/work/acme'],
    launch: async () => direct,
    home: '/home/dev',
    ...over
  }
}

describe('versionBlock', () => {
  it('says the version could not be read when the probe gave none', () => {
    expect(versionBlock('claude', null)).toBe(
      `Chat needs Claude Code ${CHAT_MIN_CLAUDE_VERSION} or later, and the version of "claude" could not be read; the tab opened in the terminal`
    )
  })

  it('says which version is too old, below the floor', () => {
    expect(versionBlock('claude', '2.1.321')).toBe(
      `Chat needs Claude Code ${CHAT_MIN_CLAUDE_VERSION} or later (this is 2.1.321); the tab opened in the terminal`
    )
  })

  it('is null at the floor and above it', () => {
    expect(versionBlock('claude', CHAT_MIN_CLAUDE_VERSION)).toBeNull()
    expect(versionBlock('claude', '2.10.0')).toBeNull()
  })
})

describe('isTrusted', () => {
  it('a folder the file trusts is trusted', () => {
    expect(isTrusted(claudeJson('/work/acme'), '/work/acme')).toBe(true)
  })

  it('a folder under a trusted parent is trusted', () => {
    expect(isTrusted(claudeJson('/work'), '/work/acme/src')).toBe(true)
  })

  it('a folder that is only a prefix of a trusted one is not trusted', () => {
    expect(isTrusted(claudeJson('/work/acme'), '/work/acm')).toBe(false)
    expect(isTrusted(claudeJson('/work/acme'), '/work')).toBe(false)
  })

  it('a project entry that does not accept the trust dialog does not trust', () => {
    const text = JSON.stringify({ projects: { '/work/acme': { hasTrustDialogAccepted: false } } })
    expect(isTrusted(text, '/work/acme')).toBe(false)
    expect(isTrusted(JSON.stringify({ projects: { '/work/acme': { hasTrustDialogAccepted: 'true' } } }), '/work/acme')).toBe(false)
  })

  it('a Windows folder under a trusted parent with other slashes and case is trusted', () => {
    expect(isTrusted(claudeJson('C:/Work/Acme'), 'c:\\work\\acme\\src')).toBe(true)
  })

  it('invalid JSON is untrusted', () => {
    expect(isTrusted('{ "projects": ', '/work/acme')).toBe(false)
    expect(isTrusted('', '/work/acme')).toBe(false)
  })

  it('a file over 16 MB is untrusted, though it would name the folder', () => {
    const text = JSON.stringify({ projects: { '/work/acme': { hasTrustDialogAccepted: true } }, pad: 'x'.repeat(17 * 1024 * 1024) })
    expect(isTrusted(text, '/work/acme')).toBe(false)
  })

  it('wrong shapes are untrusted and never throw', () => {
    expect(isTrusted('[]', '/work/acme')).toBe(false)
    expect(isTrusted('null', '/work/acme')).toBe(false)
    expect(isTrusted('{"projects": []}', '/work/acme')).toBe(false)
    expect(isTrusted('{"projects": {"/work/acme": null}}', '/work/acme')).toBe(false)
  })
})

describe('trustFile', () => {
  it('is .claude.json in CLAUDE_CONFIG_DIR when it is set', () => {
    expect(trustFile({ CLAUDE_CONFIG_DIR: '/tmp/cc' }, '/home/dev')).toBe(join('/tmp/cc', '.claude.json'))
  })

  it('is .claude.json in the home folder otherwise', () => {
    expect(trustFile({}, '/home/dev')).toBe(join('/home/dev', '.claude.json'))
    expect(trustFile({ CLAUDE_CONFIG_DIR: '' }, '/home/dev')).toBe(join('/home/dev', '.claude.json'))
  })
})

describe('chatSupport', () => {
  it('a Claude command that starts, at the floor or later and trusted, gives the launch', async () => {
    const r = await chatSupport('claude', '/work/acme', {}, deps())
    expect(r).toEqual({ launch: direct })
  })

  it('the launch reason opens the tab in the terminal', async () => {
    const r = await chatSupport('claude', '/work/acme', {}, deps({
      launch: async () => ({ how: 'none', reason: 'The Claude command "claude" cannot be started without a terminal' })
    }))
    expect(r).toEqual({ reason: 'The Claude command "claude" cannot be started without a terminal; the tab opened in the terminal' })
  })

  it('an unknown version gives the version reason', async () => {
    const r = await chatSupport('claude', '/work/acme', {}, deps({ version: async () => null }))
    expect(r).toEqual({ reason: versionBlock('claude', null) })
  })

  it('an old version gives the version reason', async () => {
    const r = await chatSupport('claude', '/work/acme', {}, deps({ version: async () => '2.1.100' }))
    expect(r).toEqual({ reason: `Chat needs Claude Code ${CHAT_MIN_CLAUDE_VERSION} or later (this is 2.1.100); the tab opened in the terminal` })
  })

  it('a folder Claude Code does not trust gives the trust reason', async () => {
    const r = await chatSupport('claude', '/work/other', {}, deps())
    expect(r).toEqual({
      reason: 'Claude Code has not been told to trust /work/other yet; the tab opened in the terminal for its trust question'
    })
  })

  it('a missing .claude.json is untrusted', async () => {
    const r = await chatSupport('claude', '/work/acme', {}, deps({ readTrust: async () => null }))
    expect(r).toHaveProperty('reason')
  })

  it('the first failing check is the reason: launch, then version, then trust', async () => {
    const all = deps({
      launch: async () => ({ how: 'none', reason: 'no terminal-less start' }),
      version: async () => '1.0.0',
      readTrust: async () => null
    })
    expect(await chatSupport('claude', '/work/acme', {}, all)).toEqual({ reason: 'no terminal-less start; the tab opened in the terminal' })

    const noLaunchFails = deps({ version: async () => '1.0.0', readTrust: async () => null })
    expect(await chatSupport('claude', '/work/acme', {}, noLaunchFails)).toEqual({ reason: versionBlock('claude', '1.0.0') })
  })

  it('reads the trust file the environment names, in the home folder by default', async () => {
    const read: string[] = []
    await chatSupport('claude', '/work/acme', { CLAUDE_CONFIG_DIR: '/tmp/cc' }, deps({
      readTrust: async (file) => {
        read.push(file)
        return ['/work/acme']
      }
    }))
    await chatSupport('claude', '/work/acme', {}, deps({
      readTrust: async (file) => {
        read.push(file)
        return ['/work/acme']
      }
    }))
    expect(read).toEqual([join('/tmp/cc', '.claude.json'), join('/home/dev', '.claude.json')])
  })
})

describe('cachedTrustList', () => {
  it('two starts with the same stat parse the file once', async () => {
    const text = claudeJson('/work/acme')
    let parses = 0
    const trusted = cachedTrustList({
      stat: async () => ({ mtimeMs: 1000, size: text.length }),
      read: async () => {
        parses++
        return text
      }
    })
    expect(await trusted('/home/dev/.claude.json')).toEqual(['/work/acme'])
    expect(await trusted('/home/dev/.claude.json')).toEqual(['/work/acme'])
    expect(parses).toBe(1)
  })

  it('a changed mtimeMs parses the file again', async () => {
    const text = claudeJson('/work/acme')
    let parses = 0
    let mtimeMs = 1000
    const trusted = cachedTrustList({
      stat: async () => ({ mtimeMs, size: text.length }),
      read: async () => {
        parses++
        return text
      }
    })
    await trusted('/home/dev/.claude.json')
    mtimeMs = 2000
    await trusted('/home/dev/.claude.json')
    expect(parses).toBe(2)
  })

  it('a file that cannot be stat gives no list, and is not read', async () => {
    let reads = 0
    const trusted = cachedTrustList({
      stat: async () => null,
      read: async () => {
        reads++
        return claudeJson('/work/acme')
      }
    })
    expect(await trusted('/home/dev/.claude.json')).toBeNull()
    expect(reads).toBe(0)
  })
})
