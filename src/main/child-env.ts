const STRIPPED = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'WT_SESSION', 'WT_PROFILE_ID'])

/** Environment for a PTY child: parent env minus ClaudeTerm/Electron/Windows Terminal markers. */
export function buildChildEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue
    if (k.startsWith('CLAUDETERM_') || STRIPPED.has(k)) continue
    env[k] = v
  }
  env.TERM_PROGRAM = 'ClaudeTerm'
  env.COLORTERM = 'truecolor'
  return env
}

/** variables a tab's launch removes from the environment, then sets */
export interface EnvPatch {
  set: Record<string, string>
  unset: string[]
}

/**
 * The environment with the patch applied. Names are matched ignoring case: Windows treats them so, and another
 * spelling of a removed variable must not survive (Claude Code would still find it).
 */
export function applyEnvPatch(env: Record<string, string>, patch: EnvPatch | undefined): Record<string, string> {
  if (!patch) return env
  const drop = new Set([...patch.unset, ...Object.keys(patch.set)].map((k) => k.toUpperCase()))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (!drop.has(k.toUpperCase())) out[k] = v
  return { ...out, ...patch.set }
}
