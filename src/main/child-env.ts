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
