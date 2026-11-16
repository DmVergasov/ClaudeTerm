// The Agent SDK's bridge: the Remote Control functions of claude.ai's code sessions. Imported at run time the first time a
// Claude tab turns Remote Control on, the same way loadSdk imports the SDK; the rest of the app never imports it.

export const BRIDGE_EXPORTS = ['createCodeSession', 'fetchRemoteCredentials', 'attachBridgeSession', 'isCredentialsFailure', 'isCredentialsRejection', 'isCreateSessionFailure'] as const

export type BridgeModule = Pick<typeof import('@anthropic-ai/claude-agent-sdk/bridge'), (typeof BRIDGE_EXPORTS)[number]>

export type BridgeLoad = { ok: true; bridge: BridgeModule } | { ok: false }

/** the bridge, imported once on first use; a failed import or a missing export answers { ok: false } every time, logged once */
export function bridgeLoader(load: () => Promise<unknown>, log: { warn(m: string): void }): () => Promise<BridgeLoad> {
  let once: Promise<BridgeLoad> | null = null
  const attempt = async (): Promise<BridgeLoad> => {
    let mod: Record<string, unknown> | null | undefined
    try {
      mod = (await load()) as Record<string, unknown> | null | undefined
    } catch (e) {
      log.warn(`the Agent SDK's bridge cannot be imported: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`)
      return { ok: false }
    }
    const missing = BRIDGE_EXPORTS.filter((name) => typeof mod?.[name] !== 'function')
    if (missing.length > 0) {
      log.warn(`the Agent SDK's bridge cannot be used: missing ${missing.join(', ')}`)
      return { ok: false }
    }
    return { ok: true, bridge: Object.fromEntries(BRIDGE_EXPORTS.map((name) => [name, mod?.[name]])) as BridgeModule }
  }
  return () => (once ??= attempt())
}

export const importBridge = (): Promise<unknown> => import('@anthropic-ai/claude-agent-sdk/bridge')
