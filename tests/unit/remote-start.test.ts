import { describe, expect, it } from 'vitest'
import { accountForEmail, remoteFolderText } from '../../src/main/coordinator/remote-start'

describe('where a session opened on another device', () => {
  it('remoteFolderText says where the session opened and why', () => {
    expect(remoteFolderText({ cwd: '/home/sam', asked: '/nope', fromTab: false, defaulted: true, project: 'acme' })).toBe('in /home/sam, its default folder (/nope is not a folder there)')
    expect(remoteFolderText({ cwd: '/home/sam/acme', asked: '/home/sam/acme', fromTab: true, defaulted: false, project: 'acme' })).toBe('in /home/sam/acme, the folder of its acme tab')
    expect(remoteFolderText({ cwd: '/w', asked: '/w', fromTab: false, defaulted: false, project: 'acme' })).toBe('in /w')
    expect(remoteFolderText({ cwd: '/home/sam', asked: null, fromTab: false, defaulted: false, project: 'acme' })).toBe('in /home/sam, its default folder (no acme tab is open there)')
  })
})

describe('the account a remote tab opens on', () => {
  it('accountForEmail picks Main account for its own email, else a readable extra account with it, else Main account', () => {
    const view = { main: { email: 'Sam@Example.com' }, accounts: [{ id: 'locked', email: 'kim@example.com', readable: false }, { id: 'work', email: 'kim@example.com', readable: true }, { id: 'token', email: null, readable: true }] }
    expect(accountForEmail(' sam@example.com ', view)).toBeNull()
    expect(accountForEmail('KIM@example.com', view)).toBe('work')
    expect(accountForEmail('lee@example.com', view)).toBeNull()
    expect(accountForEmail('kim@example.com', { ...view, main: { email: null } })).toBe('work')
  })
})
