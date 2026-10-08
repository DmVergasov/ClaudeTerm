import crossSpawn from 'cross-spawn'

/** what launchEditor needs of a started process */
export interface Launched {
  on(event: 'error', listener: (e: Error) => void): unknown
  unref(): void
}

export interface EditorDeps {
  spawn(command: string, args: string[]): Launched
  /** shows the file in its folder; never opens it: the default action of a .bat or .js under review runs it */
  reveal(file: string): void
  onError(message: string): void
}

export const DEFAULT_EDITOR = ['code', '--goto', '{file}:{line}']

/** "code --goto {file}:{line}" as arguments: spaces split them, double quotes group and are dropped */
export function splitCommand(template: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quoted = false
  for (const ch of template) {
    if (ch === '"') {
      quoted = !quoted
      has = true
    } else if (!quoted && /\s/.test(ch)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}

export function fillTemplate(args: string[], file: string, line: number): string[] {
  // replacement functions: a path holding $& or $$ is taken as it is
  return args.map((a) => a.replaceAll('{file}', () => file).replaceAll('{line}', () => String(line)))
}

/** Opens the file at the line with review.editor; null tries VS Code, else shows the file in its folder. */
export function launchEditor(template: string | null, file: string, line: number, d: EditorDeps): void {
  const [command, ...args] = fillTemplate(template === null ? DEFAULT_EDITOR : splitCommand(template), file, line)
  if (!command) {
    d.onError('review.editor is empty')
    return
  }
  const failed = (e: Error): void => {
    if (template !== null) {
      d.onError(`Cannot start the editor (${command}): ${e.message}`)
      return
    }
    d.reveal(file)
    d.onError('VS Code was not found: set review.editor to open files in your editor')
  }
  let child: Launched
  try {
    child = d.spawn(command, args)
  } catch (e) {
    failed(e as Error)
    return
  }
  child.on('error', failed)
  child.unref()
}

/** cross-spawn finds code.cmd through PATHEXT and quotes the arguments for cmd.exe; the editor runs on its own */
export function spawnDetached(command: string, args: string[]): Launched {
  return crossSpawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
}
