import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_GAMES, parseGamesSave, type GamesSave } from '../shared/games'

/** The mini-games' save: ClaudeTerm's own file in the data folder. */
export class GamesStore {
  readonly path: string
  private games: GamesSave = { ...EMPTY_GAMES }

  constructor(dir: string, private readonly onError?: (message: string) => void) {
    this.path = join(dir, 'games.json')
    this.load()
  }

  get(): GamesSave {
    return parseGamesSave(this.games).save
  }

  set(save: GamesSave): void {
    this.games = parseGamesSave(save).save
    this.save()
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      this.onError?.(`ignoring corrupt ${this.path}`)
      return
    }
    const { save, bad } = parseGamesSave(raw)
    this.games = save
    if (bad.length > 0) this.onError?.(`ignoring bad parts of ${this.path}: ${bad.join(', ')}`)
  }

  private save(): void {
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.games, null, 2), 'utf8')
      renameSync(tmp, this.path)
    } catch (e) {
      this.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
    }
  }
}
