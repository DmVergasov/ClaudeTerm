import { describe, expect, it } from 'vitest'
import { coordinatorProblem, isWorktreeName } from '../../src/shared/coordinator'

describe('coordinator shared rules', () => {
  it('coordinatorProblem names the setting when mail is off, the version when Claude Code is too old, and nothing otherwise', () => {
    expect(coordinatorProblem(false, true, '2.1.300')).toBe(
      'Coordinating sessions needs agent messages, which are turned off in ClaudeTerm on this device. Turn them on in Settings, Agent messages.'
    )
    expect(coordinatorProblem(true, false, '2.0.1')).toBe(
      'Coordinating sessions needs Claude Code 2.1.287 or later; this device runs 2.0.1.'
    )
    expect(coordinatorProblem(true, false, null)).toBe(
      'Coordinating sessions needs Claude Code 2.1.287 or later; this device runs a version ClaudeTerm has not read yet.'
    )
    expect(coordinatorProblem(true, true, '2.1.300')).toBeNull()
  })

  it('isWorktreeName takes a plain name and refuses a path, a dash first, a space and 65 characters', () => {
    expect(isWorktreeName('feat-1.x_2')).toBe(true)
    expect(isWorktreeName('a'.repeat(64))).toBe(true)
    expect(isWorktreeName('../escape')).toBe(false)
    expect(isWorktreeName('dir/name')).toBe(false)
    expect(isWorktreeName('-flag')).toBe(false)
    expect(isWorktreeName('has space')).toBe(false)
    expect(isWorktreeName('a'.repeat(65))).toBe(false)
    expect(isWorktreeName(7)).toBe(false)
  })
})
