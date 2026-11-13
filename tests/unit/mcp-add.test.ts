import { describe, expect, it } from 'vitest'
import {
  MASK,
  isServerName,
  maskText,
  maskUrl,
  maskedConfig,
  parseAddInput,
  previewRows,
  secretsOf,
  splitCommandLine,
  targetOf,
} from '../../src/shared/mcp-add'

const CONTEXT7_COMMAND = 'claude mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: sk-test-123"'

function serversOf(text: string) {
  const parsed = parseAddInput(text)
  if (parsed.kind !== 'servers') throw new Error(`expected servers, got ${parsed.kind}`)
  return parsed
}

function reasonOf(text: string): string {
  const parsed = parseAddInput(text)
  if (parsed.kind !== 'none') throw new Error(`expected none, got ${parsed.kind}`)
  return parsed.reason
}

describe('parseAddInput', () => {
  it('a claude mcp add command for an HTTP server with a header', () => {
    expect(parseAddInput(CONTEXT7_COMMAND)).toEqual({
      kind: 'servers',
      servers: [{
        name: 'context7',
        config: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: 'sk-test-123' } },
      }],
      scope: null,
      needsClientSecret: false,
    })
  })

  it('a stdio server with env after the name and its command after --', () => {
    const parsed = serversOf('claude mcp add my-server -e API_KEY=xxx -- npx my-mcp-server')
    expect(parsed.servers).toEqual([{
      name: 'my-server',
      config: { type: 'stdio', command: 'npx', args: ['my-mcp-server'], env: { API_KEY: 'xxx' } },
    }])
  })

  it('the scope the command names is kept', () => {
    expect(serversOf('claude mcp add -s project context7 https://mcp.context7.com/mcp').scope).toBe('project')
    expect(serversOf('claude mcp add --scope local context7 https://mcp.context7.com/mcp').scope).toBe('local')
  })

  it('add-json takes its JSON', () => {
    expect(parseAddInput(`claude mcp add-json context7 '{"type":"http","url":"https://mcp.context7.com/mcp"}'`)).toEqual({
      kind: 'servers',
      servers: [{ name: 'context7', config: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: {} } }],
      scope: null,
      needsClientSecret: false,
    })
  })

  it('an mcpServers object, a servers object, named configs and a bare config', () => {
    expect(serversOf('{"mcpServers":{"a":{"command":"npx","args":["x"]}}}').servers).toEqual([
      { name: 'a', config: { type: 'stdio', command: 'npx', args: ['x'], env: {} } },
    ])
    expect(serversOf('{"servers":{"b":{"type":"http","url":"https://b.example/mcp"}}}').servers).toEqual([
      { name: 'b', config: { type: 'http', url: 'https://b.example/mcp', headers: {} } },
    ])
    expect(serversOf('{"c1":{"command":"uvx"},"c2":{"url":"https://c2.dev/mcp"}}').servers).toEqual([
      { name: 'c1', config: { type: 'stdio', command: 'uvx', args: [], env: {} } },
      { name: 'c2', config: { type: 'http', url: 'https://c2.dev/mcp', headers: {} } },
    ])
    expect(serversOf('{"command":"npx","args":["-y","@upstash/context7-mcp"]}').servers).toEqual([
      { name: 'context7-mcp', config: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: {} } },
    ])
  })

  it('a bare URL is an HTTP server named after its host', () => {
    expect(parseAddInput('https://mcp.context7.com/mcp')).toEqual({
      kind: 'servers',
      servers: [{ name: 'context7', config: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: {} } }],
      scope: null,
      needsClientSecret: false,
    })
  })

  it('a GitHub repository link is a marketplace', () => {
    expect(parseAddInput('https://github.com/acme/tools/tree/main')).toEqual({ kind: 'github', source: 'acme/tools' })
  })

  it('a command line that is not claude is a stdio server named after its package', () => {
    expect(serversOf('npx -y @upstash/context7-mcp').servers).toEqual([
      { name: 'context7-mcp', config: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: {} } },
    ])
  })

  it('quotes, escaped quotes, a line continuation and a $ prompt', () => {
    const expected = serversOf(CONTEXT7_COMMAND).servers
    expect(serversOf(`$ claude mcp add --transport http \\\n  context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: sk-test-123"`).servers).toEqual(expected)
    expect(serversOf(`> ${CONTEXT7_COMMAND}`).servers).toEqual(expected)
    expect(serversOf(String.raw`npx server 'a b' "c \"d\" e\\f"`).servers[0].config).toEqual({
      type: 'stdio', command: 'npx', args: ['server', 'a b', 'c "d" e\\f'], env: {},
    })
  })

  it('--client-secret asks for the secret, --client-id and --callback-port go in oauth', () => {
    const parsed = serversOf('claude mcp add --transport http --client-id abc --client-secret --callback-port 8080 sec https://x.dev/mcp')
    expect(parsed.needsClientSecret).toBe(true)
    expect(parsed.servers).toEqual([{
      name: 'sec',
      config: { type: 'http', url: 'https://x.dev/mcp', headers: {}, oauth: { clientId: 'abc', callbackPort: 8080 } },
    }])
  })

  it('a header word is split at its first colon and a URL is never a header', () => {
    expect(serversOf('claude mcp add --transport http -H "A: b" ctx https://x.dev/mcp').servers).toEqual([
      { name: 'ctx', config: { type: 'http', url: 'https://x.dev/mcp', headers: { A: 'b' } } },
    ])
    expect(serversOf('claude mcp add --transport http ctx https://x.dev/mcp -H "Authorization: Bearer a:b"').servers[0].config)
      .toEqual({ type: 'http', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer a:b' } })
  })

  it('env words stop at the first word that is not KEY=value', () => {
    expect(serversOf('claude mcp add -e A=1 B=2 my -- npx x').servers).toEqual([
      { name: 'my', config: { type: 'stdio', command: 'npx', args: ['x'], env: { A: '1', B: '2' } } },
    ])
  })

  it('text that is none of these says why', () => {
    expect(reasonOf('')).toBe('Paste a command, a server URL or a JSON config')
    expect(reasonOf(' \n\t ')).toBe('Paste a command, a server URL or a JSON config')
    expect(reasonOf('a'.repeat(65537))).toBe('The text is too long')
    expect(reasonOf('{ not json')).toMatch(/^The JSON does not parse: .{1,200}$/)
    expect(reasonOf('{"a":5}')).toBe('Not a claude mcp add command, a URL or a JSON config')
    expect(reasonOf('claude mcp list')).toBe('Not a claude mcp add command, a URL or a JSON config')
    expect(reasonOf('claude mcp add -s nowhere x https://x.dev/mcp')).toBe('Not a claude mcp add command, a URL or a JSON config')
    expect(reasonOf('claude mcp add x "npx')).toBe('A quote is not closed')
    expect(reasonOf('npx "foo')).toBe('A quote is not closed')
    expect(reasonOf('ftp://files.example.com/mcp')).toBe('Only http and https addresses')
    expect(reasonOf('{"url":"file:///etc/x"}')).toBe('Only http and https addresses')
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 21; i++) many[`s${i}`] = { command: 'x' }
    expect(reasonOf(JSON.stringify(many))).toBe('At most 20 servers at once')
  })

  it('a name that is not valid becomes its valid characters or server', () => {
    expect(serversOf('{"mcpServers":{"my server!":{"command":"x"}}}').servers[0].name).toBe('myserver')
    expect(serversOf('{"mcpServers":{"!!!":{"command":"x"}}}').servers[0].name).toBe('server')
    expect(serversOf(`{"mcpServers":{"${'x'.repeat(70)}":{"command":"x"}}}`).servers[0].name).toBe('x'.repeat(64))
  })
})

describe('names of plain commands and URLs', () => {
  it('a name taken from a plain command or a URL is made valid too', () => {
    const cases: [string, string][] = [
      ['node ./server.js', 'server.js'],
      ['http://[::1]/mcp', 'server'],
      ['npx @scope/pkg/sub', 'pkgsub'],
      [`npx ${'a'.repeat(100)}`, 'a'.repeat(64)],
    ]
    for (const [text, name] of cases) {
      const server = serversOf(text).servers[0]
      expect(server.name).toBe(name)
      expect(isServerName(server.name)).toBe(true)
    }
  })
})

describe('previewRows', () => {
  it('previewRows masks every header and env value and a URL\'s secret query values', () => {
    const url = serversOf('https://x.dev/mcp?api_key=abc&mode=1').servers[0]
    expect(previewRows(url)).toContainEqual({ label: 'Address', value: 'https://x.dev/mcp?api_key=••••••••&mode=1' })

    const http = serversOf(CONTEXT7_COMMAND).servers[0]
    expect(previewRows(http)).toEqual([
      { label: 'Type', value: 'HTTP' },
      { label: 'Address', value: 'https://mcp.context7.com/mcp' },
      { label: 'Header', value: `CONTEXT7_API_KEY: ${MASK}` },
    ])

    const stdio = serversOf('claude mcp add my-server -e API_KEY=xxx -- npx my-mcp-server').servers[0]
    expect(previewRows(stdio)).toEqual([
      { label: 'Type', value: 'stdio' },
      { label: 'Command', value: 'npx my-mcp-server' },
      { label: 'Env', value: `API_KEY=${MASK}` },
    ])
    expect(JSON.stringify(previewRows(http))).not.toContain('sk-test-123')
  })

  it('previewRows shows the OAuth client id', () => {
    const server = serversOf('claude mcp add --transport http --client-id abc sec https://x.dev/mcp').servers[0]
    expect(previewRows(server)).toContainEqual({ label: 'OAuth client', value: 'abc' })
  })
})

describe('masking', () => {
  it('maskText gives the board\'s masked command', () => {
    const server = serversOf(CONTEXT7_COMMAND).servers[0]
    expect(maskText(CONTEXT7_COMMAND, secretsOf(server.config)))
      .toBe('claude mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: ••••••••"')
  })

  it('maskUrl and secretsOf hide the password in the URL userinfo', () => {
    expect(maskUrl('https://user:pass@host/mcp')).toBe(`https://user:${MASK}@host/mcp`)
    expect(secretsOf({ type: 'http', url: 'https://user:pass@host/mcp', headers: {} })).toEqual(['pass'])
    const server = serversOf('https://user:pass@host/mcp').servers[0]
    expect(previewRows(server)).toContainEqual({ label: 'Address', value: `https://user:${MASK}@host/mcp` })
    expect(JSON.stringify(previewRows(server))).not.toContain('pass')
  })

  it('maskText hides a secret written JSON-escaped in a pasted JSON config', () => {
    const text = '{"mcpServers":{"c":{"type":"http","url":"https://x.dev/mcp","headers":{"X":"ab\\"c"}}}}'
    const server = serversOf(text).servers[0]
    expect(secretsOf(server.config)).toEqual(['ab"c'])
    expect(maskText(text, secretsOf(server.config)))
      .toBe(`{"mcpServers":{"c":{"type":"http","url":"https://x.dev/mcp","headers":{"X":"${MASK}"}}}}`)
  })

  it('maskText hides a secret written with \\" inside a double-quoted shell word', () => {
    const text = 'claude mcp add --transport http ctx https://x.dev/mcp --header "X: ab\\"c"'
    const server = serversOf(text).servers[0]
    expect(secretsOf(server.config)).toEqual(['ab"c'])
    expect(maskText(text, secretsOf(server.config)))
      .toBe(`claude mcp add --transport http ctx https://x.dev/mcp --header "X: ${MASK}"`)
  })

  it('maskText replaces the longest secret first', () => {
    expect(maskText('xabcx', ['ab', 'abc'])).toBe(`x${MASK}x`)
  })

  it('secretsOf lists every non-empty header and env value', () => {
    expect(secretsOf({ type: 'http', url: 'https://x.dev', headers: { A: '1', B: '' } })).toEqual(['1'])
    expect(secretsOf({ type: 'stdio', command: 'npx', args: [], env: { C: '2' } })).toEqual(['2'])
  })

  it('secretsOf lists the secret-looking query values of a URL, raw and decoded, the same ones maskUrl hides', () => {
    expect(secretsOf({ type: 'http', url: 'https://mcp.example.com/mcp?apiKey=sk-test-123', headers: {} })).toEqual(['sk-test-123'])
    expect(secretsOf({ type: 'http', url: 'https://x.dev/mcp?token=a%2Bb&mode=1', headers: {} })).toEqual(['a%2Bb', 'a+b'])
    expect(secretsOf({ type: 'http', url: 'https://x.dev/mcp?mode=1&key=', headers: {} })).toEqual([])
  })

  it('maskUrl masks only secret-looking query values', () => {
    expect(maskUrl('https://x.dev/mcp?api_key=abc&mode=1')).toBe('https://x.dev/mcp?api_key=••••••••&mode=1')
    expect(maskUrl('https://x.dev/mcp?Access_Token=abc')).toBe(`https://x.dev/mcp?Access_Token=${MASK}`)
    expect(maskUrl('https://x.dev/mcp')).toBe('https://x.dev/mcp')
  })

  it('targetOf is the masked URL, or the command with a spaced argument in quotes', () => {
    expect(targetOf({ type: 'http', url: 'https://x.dev/mcp?token=1', headers: {} })).toBe(`https://x.dev/mcp?token=${MASK}`)
    expect(targetOf({ type: 'stdio', command: 'npx', args: ['run', 'a b'], env: {} })).toBe('npx run "a b"')
  })

  it('maskedConfig masks header and env values and the URL, and leaves the input alone', () => {
    const http = { type: 'http' as const, url: 'https://x.dev/mcp?api_key=abc', headers: { K: 'v' } }
    expect(maskedConfig(http)).toEqual({ type: 'http', url: `https://x.dev/mcp?api_key=${MASK}`, headers: { K: MASK } })
    expect(http.headers.K).toBe('v')
    expect(maskedConfig({ type: 'stdio', command: 'npx', args: ['x'], env: { E: 'v' } }))
      .toEqual({ type: 'stdio', command: 'npx', args: ['x'], env: { E: MASK } })
  })
})

describe('splitCommandLine', () => {
  it('splits by POSIX rules and returns null for an unclosed quote', () => {
    expect(splitCommandLine(String.raw`a 'b c' "d \"e\" f\\g" h\ i`)).toEqual(['a', 'b c', 'd "e" f\\g', 'h i'])
    expect(splitCommandLine('a "b')).toBeNull()
    expect(splitCommandLine("a 'b")).toBeNull()
  })
})

describe('isServerName', () => {
  it('accepts letters, digits, dots, dashes and underscores after a letter or digit, up to 64 characters', () => {
    expect(isServerName('context7')).toBe(true)
    expect(isServerName('my_server.v2')).toBe(true)
    expect(isServerName('-x')).toBe(false)
    expect(isServerName('a b')).toBe(false)
    expect(isServerName('a'.repeat(65))).toBe(false)
    expect(isServerName('a'.repeat(64))).toBe(true)
    expect(isServerName('')).toBe(false)
  })
})
