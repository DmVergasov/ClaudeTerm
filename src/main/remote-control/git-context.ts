import { GitError, type GitRun } from '../git-source'

/** what claude.ai's code session learns of the checkout: its origin, its branch and the origin's default branch */
export interface GitContext {
  gitRepoUrl: string
  branch: string
  defaultBranch?: string
}

/** git's answer, trimmed; null when git fails (a non-zero exit or a GitError) or prints nothing */
async function gitLine(git: GitRun, args: string[], cwd: string): Promise<string | null> {
  let r
  try {
    r = await git(args, cwd)
  } catch (e) {
    if (e instanceof GitError) return null
    throw e
  }
  const out = r.stdout.toString('utf8').trim()
  return r.code === 0 && out ? out : null
}

/** a web or ssh address loses the user and password it carries; an scp-like address (git@host:path) and a local path are git's own text */
function withoutCredentials(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol) || (parsed.username === '' && parsed.password === '')) return url
  parsed.username = ''
  parsed.password = ''
  return parsed.toString()
}

/** the checkout's origin, branch and default branch; null when cwd is not a repository or has no origin */
export async function gitContextOf(cwd: string, git: GitRun): Promise<GitContext | null> {
  const url = await gitLine(git, ['remote', 'get-url', 'origin'], cwd)
  if (url === null) return null
  const branch = await gitLine(git, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (branch === null) return null
  const head = await gitLine(git, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd)
  const defaultBranch = head?.replace(/^origin\//, '')
  return { gitRepoUrl: withoutCredentials(url), branch, ...(defaultBranch ? { defaultBranch } : {}) }
}
