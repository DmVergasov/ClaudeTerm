import { describe, expect, it } from 'vitest'
import { accountNote, remoteLine, remoteSwitch, remoteTitle } from '../../src/renderer/remote-popover'

const URL = 'https://claude.ai/code/session_01abc'

describe('the segment’s and the popover’s words', () => {
  it('titles', () => {
    expect(remoteTitle({ kind: 'off' })).toBe('Remote Control is off: click to turn it on')
    expect(remoteTitle({ kind: 'connecting' })).toBe('Remote Control is connecting…')
    expect(remoteTitle({ kind: 'connecting', note: "Waiting for Claude Code to renew this account's sign-in" })).toBe("Waiting for Claude Code to renew this account's sign-in")
    expect(remoteTitle({ kind: 'on', url: URL })).toBe('Remote Control is on: this session is on claude.ai and in the Claude app')
    expect(remoteTitle({ kind: 'unavailable', reason: 'R1' })).toBe('R1')
    expect(remoteTitle({ kind: 'failed', reason: 'R2' })).toBe('R2')
  })
  it('status lines, with the wait for an empty prompt after any of them', () => {
    expect(remoteLine({ kind: 'off' })).toBe('Off · turn it on to reach this session from your phone')
    expect(remoteLine({ kind: 'connecting' })).toBe('Connecting…')
    expect(remoteLine({ kind: 'connecting', waits: true })).toBe('Connecting… · waits for an empty prompt')
    expect(remoteLine({ kind: 'connecting', note: 'N' })).toBe('N')
    expect(remoteLine({ kind: 'on', url: URL })).toBe('Connected · continue this session in the Claude app or on claude.ai')
    expect(remoteLine({ kind: 'on', url: URL, leaving: true, waits: true })).toBe('Choose Disconnect this session in the terminal · waits for an empty prompt')
    expect(remoteLine({ kind: 'failed', reason: 'R2' })).toBe('R2')
  })
  it('the switch: on while connecting or connected, off once the person asked off, disabled only when unavailable', () => {
    expect(remoteSwitch({ kind: 'off' })).toEqual({ checked: false, disabled: false })
    expect(remoteSwitch({ kind: 'connecting' })).toEqual({ checked: true, disabled: false })
    expect(remoteSwitch({ kind: 'on', url: URL })).toEqual({ checked: true, disabled: false })
    expect(remoteSwitch({ kind: 'on', url: URL, leaving: true })).toEqual({ checked: false, disabled: false })
    expect(remoteSwitch({ kind: 'unavailable', reason: 'R1' })).toEqual({ checked: false, disabled: true })
    expect(remoteSwitch({ kind: 'failed', reason: 'R2' })).toEqual({ checked: false, disabled: false })
  })
  it('the account note names the account', () => {
    expect(accountNote('Work')).toBe('New Claude tabs of Work start with Remote Control on')
  })
})
