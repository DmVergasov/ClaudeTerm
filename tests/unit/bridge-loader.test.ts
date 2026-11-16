import { describe, expect, it } from 'vitest'
import { BRIDGE_EXPORTS, bridgeLoader } from '../../src/main/remote-control/bridge-loader'

const fn = (): void => {}
const full = Object.fromEntries(BRIDGE_EXPORTS.map((n) => [n, fn]))

describe('bridge loader', () => {
  it('imports once, and hands the six functions on', async () => {
    let imports = 0
    const load = bridgeLoader(async () => { imports++; return full }, { warn: () => {} })
    const [a, b] = await Promise.all([load(), load()])
    expect(a).toEqual({ ok: true, bridge: expect.objectContaining({ createCodeSession: fn }) })
    expect(b.ok).toBe(true)
    expect(imports).toBe(1)
  })

  it('a missing export: not ok, and the log names every missing one, once', async () => {
    const warns: string[] = []
    const load = bridgeLoader(async () => ({ ...full, attachBridgeSession: undefined, isCreateSessionFailure: 1 }), { warn: (m) => warns.push(m) })
    expect(await load()).toEqual({ ok: false })
    expect(await load()).toEqual({ ok: false })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('attachBridgeSession')
    expect(warns[0]).toContain('isCreateSessionFailure')
  })

  it('an import that throws: not ok, logged once, never tried again', async () => {
    let imports = 0
    const warns: string[] = []
    const load = bridgeLoader(async () => { imports++; throw new Error('Cannot find module') }, { warn: (m) => warns.push(m) })
    expect(await load()).toEqual({ ok: false })
    expect(await load()).toEqual({ ok: false })
    expect(imports).toBe(1)
    expect(warns).toEqual(["the Agent SDK's bridge cannot be imported: Cannot find module"])
  })
})
