import type { GameId, GamesSave } from '../../shared/games'

/** One game in the game window: its own board or world, its keys, and its part of the save */
export interface GameView {
  readonly id: GameId
  readonly title: string
  readonly el: HTMLElement
  /** false for a game that keeps running (Clicker): the window never pauses it */
  readonly pausable: boolean
  /** whether the window's pause stops it now: a pausable game in play (Runner only during a run; a game with nothing to stop is not paused) */
  canPause(): boolean
  /** a key while the game has the keyboard (repeats already dropped); true when it is one of the game's keys */
  key(code: string, down: boolean): boolean
  /** shown: the window is open, unfolded, shows this game and the app is focused; live: shown, not paused and the game has the keyboard */
  setState(shown: boolean, live: boolean): void
  /** writes its part into the save */
  saveInto(save: GamesSave): void
  /** its line in the game menu: 'best 3,311' or '12.4K lines' */
  menuNote(): string
}
