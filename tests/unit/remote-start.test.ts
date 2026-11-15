import { describe, expect, it } from 'vitest'
import { accountForEmail } from '../../src/main/coordinator/remote-start'

describe('the account a remote tab opens on', () => {
  it('accountForEmail picks Main account for its own email, else a readable extra account with it, else Main account', () => {
    const view = { main: { email: 'Sam@Example.com' }, accounts: [{ id: 'locked', email: 'kim@example.com', readable: false }, { id: 'work', email: 'kim@example.com', readable: true }, { id: 'token', email: null, readable: true }] }
    expect(accountForEmail(' sam@example.com ', view)).toBeNull()
    expect(accountForEmail('KIM@example.com', view)).toBe('work')
    expect(accountForEmail('lee@example.com', view)).toBeNull()
    expect(accountForEmail('kim@example.com', { ...view, main: { email: null } })).toBe('work')
  })
})
