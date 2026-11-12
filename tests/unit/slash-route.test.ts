import { describe, expect, it } from 'vitest'
import { routeSlash } from '../../src/renderer/chat/slash-menu'
import type { ChatCommandInfo } from '../../src/shared/chat'

const command = (name: string, extra: Partial<ChatCommandInfo> = {}): ChatCommandInfo => ({
  name,
  description: '',
  argumentHint: '',
  group: 'builtin',
  source: null,
  terminal: false,
  ...extra
})

describe('routeSlash', () => {
  it('/model with no arguments is answered natively', () => {
    expect(routeSlash('/model', [])).toEqual({ to: 'native', name: 'model' })
  })

  it('/model with arguments is sent to Claude Code as it is', () => {
    expect(routeSlash('/model opus', [])).toEqual({ to: 'send', text: '/model opus' })
  })

  it('/resume with no arguments is answered natively', () => {
    expect(routeSlash('/resume', [])).toEqual({ to: 'native', name: 'resume' })
  })

  it('the built-ins that need the terminal go there, with the whole text as the line', () => {
    for (const name of ['config', 'permissions', 'agents', 'login', 'logout', 'doctor', 'rewind', 'terminal-setup', 'ide', 'vim', 'statusline', 'exit']) {
      expect(routeSlash(`/${name}`, [])).toEqual({ to: 'terminal', line: `/${name}` })
    }
  })

  it('a command the list marks as terminal goes to the terminal, with its arguments', () => {
    expect(routeSlash('/deploy prod', [command('deploy', { terminal: true })])).toEqual({ to: 'terminal', line: '/deploy prod' })
  })

  it('a text that starts with ! goes to the terminal as the whole line', () => {
    expect(routeSlash('!npm test', [])).toEqual({ to: 'terminal', line: '!npm test' })
  })

  it('any other command, and any text, is sent', () => {
    expect(routeSlash('/context', [command('context')])).toEqual({ to: 'send', text: '/context' })
    expect(routeSlash('/compact focus on the tests', [command('compact')])).toEqual({ to: 'send', text: '/compact focus on the tests' })
    expect(routeSlash('hello', [])).toEqual({ to: 'send', text: 'hello' })
  })

  it('a command name that only starts like a terminal one is sent', () => {
    expect(routeSlash('/configure', [])).toEqual({ to: 'send', text: '/configure' })
  })
})
