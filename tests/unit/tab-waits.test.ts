import { describe, expect, it, vi } from 'vitest'
import { TabWaits } from '../../src/main/tab-waits'

const NOW = 1_700_000_000_000
const TAB = 'tab-1'

function setup() {
  const changed: string[] = []
  const waits = new TabWaits({ now: () => NOW, onChange: (tabId) => changed.push(tabId) })
  return { waits, changed }
}

describe('TabWaits', () => {
  it('a dialog opened shows its prompt until the dialogs close', () => {
    const { waits, changed } = setup()
    waits.dialogOpened(TAB, 'permission', 'Allow Bash: npm test')
    expect(waits.get(TAB)).toEqual({ prompt: { kind: 'permission', text: 'Allow Bash: npm test', since: NOW }, limit: null })
    waits.dialogsClosed(TAB)
    expect(waits.get(TAB).prompt).toBeNull()
    expect(changed).toEqual([TAB, TAB])
  })

  it('a usage limit stays with its reset time until the next turn starts', () => {
    const { waits } = setup()
    waits.limited(TAB, NOW + 3_600_000)
    expect(waits.get(TAB)).toEqual({ prompt: null, limit: { resetsAt: NOW + 3_600_000, since: NOW } })
    waits.turnStarted(TAB)
    expect(waits.get(TAB).limit).toBeNull()
  })

  it('onChange is called for each change and not for a call that changes nothing; removeTab forgets the tab', () => {
    const { waits, changed } = setup()
    waits.dialogsClosed(TAB)
    waits.turnStarted(TAB)
    expect(changed).toEqual([])
    waits.dialogOpened(TAB, 'question', 'Which branch?')
    waits.dialogOpened(TAB, 'question', 'Which branch?')
    waits.limited(TAB, null)
    waits.limited(TAB, null)
    waits.turnStarted(TAB)
    expect(changed).toEqual([TAB, TAB, TAB])
    waits.removeTab(TAB)
    expect(changed).toHaveLength(4)
    expect(waits.get(TAB)).toEqual({ prompt: null, limit: null })
    waits.removeTab(TAB)
    expect(changed).toHaveLength(4)
  })

  it('a tab it does not know has neither a prompt nor a limit', () => {
    const { waits } = setup()
    expect(waits.get('unknown')).toEqual({ prompt: null, limit: null })
  })

  it('a second dialog while one is open replaces the prompt and starts its own time', () => {
    const clock = vi.fn(() => NOW)
    const waits = new TabWaits({ now: clock, onChange: () => {} })
    waits.dialogOpened(TAB, 'permission', 'Allow Edit: a.ts')
    clock.mockReturnValue(NOW + 500)
    waits.dialogOpened(TAB, 'question', null)
    expect(waits.get(TAB).prompt).toEqual({ kind: 'question', text: null, since: NOW + 500 })
  })
})
