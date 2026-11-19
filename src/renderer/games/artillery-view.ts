import type { GamesSave } from '../../shared/games'
import { driveBot } from './artillery-bot'
import { teleportOk } from './artillery-bodies'
import { ARTILLERY, WEAPONS } from './artillery-config'
import { dropCharge, inBattle, newBattle, start, step, tally, teamHp } from './artillery-rules'
import { aimVector } from './artillery-shots'
import type { ArtilleryInput, ArtilleryRecord, ArtilleryState, Ground, Team } from './artillery-types'
import { BUG, paintPixels } from './bug'
import { CLAWD, paintSprite } from './clawd'
import { FrameLoop } from './frame-loop'
import type { GameView } from './game-view'
import { newSeed, seeded } from './random'

const MONO = 'ui-monospace, Consolas, monospace'

const fmt = (n: number): string => n.toLocaleString('en-US')

/** the keys of the game: the arrows, Space, the turn keys, Tab, the digits and Shift */
const DIGIT_KEYS: readonly string[] = WEAPONS.map((_, i) => `Digit${i + 1}`)
const GAME_KEYS: readonly string[] = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Space',
  'Enter',
  'NumpadEnter',
  'Tab',
  'ShiftLeft',
  'ShiftRight',
  ...DIGIT_KEYS
]
/** the keys whose state is held: the arrows, Space and Shift */
const HELD_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'ShiftLeft', 'ShiftRight'])
const SHIFT_KEYS: readonly string[] = ['ShiftLeft', 'ShiftRight']

/** how long the turn's banner shows, seconds */
const BANNER_TIME = 1.2
/** the minimap shows the map at a third of its size */
const MINI = 3
const MINI_H = (ARTILLERY.height - ARTILLERY.minimapTop) / MINI
/** the fighters of a team, for the HP bar's full length */
const TEAM_SIZE = 3
/** the dotted aim's length from the muzzle, px */
const AIM_LEN = 40
/** the power bar's cells */
const POWER_CELLS = 6

/** the stars: fixed for every battle, in the map's top rows */
const STAR_COUNT = 16
const STAR_ROWS = 50
const starRand = seeded(11)
const STARS = Array.from({ length: STAR_COUNT }, () => ({
  x: Math.floor(starRand.next() * ARTILLERY.width),
  y: Math.floor(starRand.next() * STAR_ROWS)
}))

/** a team's HUD: its box, its total and its HP bar */
interface TeamHud {
  box: HTMLElement
  num: HTMLElement
  fill: HTMLElement
}

function el(tag: 'div' | 'span', cls: string, text = ''): HTMLElement {
  const e = document.createElement(tag)
  e.className = cls
  e.textContent = text
  return e
}

/** a map cell that is ground; outside the map is not */
function isGround(g: Ground, x: number, y: number): boolean {
  return x >= 0 && x < g.w && y >= 0 && y < g.h && g.cells[y * g.w + x] === 1
}

/** the sparse texture of the ground: a fixed pattern of about one cell in seventeen */
function speckled(x: number, y: number): boolean {
  return ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % 17 === 0
}

/** a small crosshair centred on (x, y) */
function crosshair(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = color
  ctx.fillRect(Math.round(x) - 4, Math.round(y), 9, 1)
  ctx.fillRect(Math.round(x), Math.round(y) - 4, 1, 9)
}

/** the seconds as m:ss, whole seconds up */
function clockText(seconds: number): string {
  const t = Math.ceil(seconds)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

/** the ammo as the bar shows it: ∞ for no limit */
function ammoText(n: number): string {
  return n === Infinity ? '∞' : String(n)
}

/** the wind as arrows, one to three by its strength; none for calm */
function windArrows(wind: number): string {
  if (wind === 0) return ''
  const n = Math.min(3, Math.ceil(Math.abs(wind) / (ARTILLERY.windMax / 3)))
  return (wind < 0 ? '◂' : '▸').repeat(n)
}

/** the keys for the moment: the start and the end, the bugs' turn, the retreat, a cursor, the aim */
function hintText(s: ArtilleryState): string {
  if (s.phase === 'title') return 'Space starts a battle'
  if (s.phase === 'over') return 'Space starts a new battle'
  if (s.team === 'bug') return 'the bugs are playing'
  if (s.retreat > 0) return '←/→ get away · Enter jump'
  if (s.cursor !== null) return 'arrows move · Space here'
  // between Ping's two shots the walk and the weapon keys do nothing
  if (s.phase === 'aim' && s.pingLeft > 0) return '↑/↓ aim · Space fire'
  if (s.phase === 'aim') return '←/→ walk · ↑/↓ aim · Space fire · Tab weapon'
  return ''
}

/** Artillery: the Clawds against the bugs, one fighter a turn, on a map three windows wide with destructible ground */
export class ArtilleryView implements GameView {
  readonly id = 'artillery' as const
  readonly title = 'Artillery'
  readonly el = document.createElement('div')
  readonly pausable = true
  readonly realtime = true
  private state: ArtilleryState
  private record: ArtilleryRecord
  /** shown, not paused, and the game has the keyboard */
  private live = false
  /** the game's keys held down: the arrows, Space and Shift */
  private readonly held = new Set<string>()
  /** the game's keys pressed since the last frame, so that a tap shorter than a frame still acts */
  private readonly pressed = new Set<string>()
  /** whether Shift was down when Tab was pressed: read at the press, as a quick tap can be released before the frame */
  private tabBack = false
  private readonly loop = new FrameLoop((dt) => this.advance(dt))
  /** the battle the offscreen ground is painted for, and how many of its carved boxes are painted */
  private paintedBattle: number | null = null
  private paintedCarved = 0
  /** the seconds the turn's banner still shows, and the turn it was shown for */
  private banner = 0
  private turnKey = ''
  /** the frames painted, for the water's wave */
  private frames = 0
  /** the theme's colors, read once */
  private readonly colors: Record<'accent' | 'purple' | 'blue' | 'amber' | 'red' | 'text' | 'text3' | 'line2' | 'line3' | 'raised' | 'raised2' | 'well', string>
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly mini = document.createElement('canvas')
  private readonly miniCtx: CanvasRenderingContext2D
  /** the whole map as ground, painted cell by cell; the field and the minimap draw from it */
  private readonly ground = document.createElement('canvas')
  private readonly groundCtx: CanvasRenderingContext2D
  private readonly clawdHud: TeamHud
  private readonly bugHud: TeamHud
  private readonly wind: HTMLElement
  private readonly time: HTMLElement
  private readonly flood: HTMLElement
  private readonly weapons: { cell: HTMLElement; ammo: HTMLElement }[]
  private readonly strip: HTMLElement
  private readonly name: HTMLElement
  private readonly aim: HTMLElement
  private readonly hint: HTMLElement
  private readonly message: HTMLElement

  constructor(
    record: ArtilleryRecord,
    private readonly changed: () => void,
    private readonly seed: () => number = newSeed,
    private readonly make: (seed: number, streak: number) => ArtilleryState = newBattle
  ) {
    this.record = { ...record }
    this.state = make(seed(), this.record.streak)
    this.el.className = 'artillery'

    const dpr = window.devicePixelRatio || 1
    const sized = (c: HTMLCanvasElement, h: number, cls: string): CanvasRenderingContext2D => {
      c.className = cls
      c.width = ARTILLERY.view * dpr
      c.height = h * dpr
      const ctx = c.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // the ground is drawn scaled: its cells stay sharp at any display scaling
      ctx.imageSmoothingEnabled = false
      return ctx
    }
    this.ctx = sized(this.canvas, ARTILLERY.height, 'artillery-field')
    this.miniCtx = sized(this.mini, MINI_H, 'artillery-mini')
    this.ground.width = ARTILLERY.width
    this.ground.height = ARTILLERY.height
    this.groundCtx = this.ground.getContext('2d')!

    const style = getComputedStyle(document.documentElement)
    const color = (name: string): string => style.getPropertyValue(name).trim()
    this.colors = {
      accent: color('--accent'),
      purple: color('--purple'),
      blue: color('--blue'),
      amber: color('--amber'),
      red: color('--red'),
      text: color('--text'),
      text3: color('--text-3'),
      line2: color('--line-2'),
      line3: color('--line-3'),
      raised: color('--raised'),
      raised2: color('--raised-2'),
      well: color('--well')
    }

    this.clawdHud = this.teamHud('clawd')
    this.bugHud = this.teamHud('bug')
    this.wind = el('span', 'artillery-wind')
    this.time = el('span', 'artillery-time')
    this.flood = el('span', 'artillery-flood', 'flood')
    const mid = el('div', 'artillery-mid')
    mid.append(this.wind, this.time, this.flood)
    const hud = el('div', 'artillery-hud')
    hud.append(this.clawdHud.box, mid, this.bugHud.box)

    this.weapons = WEAPONS.map((w) => {
      const ammo = el('span', 'artillery-ammo')
      const cell = el('div', 'artillery-weapon')
      cell.append(el('span', 'artillery-glyph', w.glyph), ammo)
      return { cell, ammo }
    })
    this.strip = el('div', 'artillery-weapons')
    this.strip.append(...this.weapons.map((w) => w.cell))

    this.name = el('span', 'artillery-name')
    this.aim = el('span', 'artillery-aim')
    const info = el('div', 'artillery-info')
    info.append(this.name, this.aim)
    this.hint = el('div', 'artillery-hint')

    this.message = el('div', 'artillery-message')
    const stage = el('div', 'artillery-stage')
    stage.append(this.canvas, this.message)

    this.el.append(hud, this.mini, stage, this.strip, info, this.hint)
    this.paint()
  }

  /** a battle in play is paused; on the title and after a battle there is nothing to stop */
  canPause(): boolean {
    return inBattle(this.state)
  }

  key(code: string, down: boolean): boolean {
    if (!GAME_KEYS.includes(code)) return false
    if (!down) {
      this.held.delete(code)
      return true
    }
    if (!this.live) return true
    if (!inBattle(this.state)) {
      // Space on the title or after a battle starts one: it is not also a shot
      if (code === 'Space') this.begin()
      return true
    }
    if (HELD_KEYS.has(code)) this.held.add(code)
    this.pressed.add(code)
    if (code === 'Tab') this.tabBack = SHIFT_KEYS.some((shift) => this.held.has(shift))
    return true
  }

  setState(shown: boolean, live: boolean): void {
    this.live = shown && live
    if (this.live && inBattle(this.state)) {
      this.loop.start()
    } else {
      this.loop.stop()
      this.held.clear()
      this.pressed.clear()
      this.state = dropCharge(this.state)
    }
    this.paint()
  }

  saveInto(save: GamesSave): void {
    save.artilleryWins = this.record.wins
    save.artilleryStreak = this.record.streak
    save.artilleryBest = this.record.best
  }

  menuNote(): string {
    return `wins ${fmt(this.record.wins)}`
  }

  /** starts a battle: the one on the title, or after a battle a new one at the record's streak */
  private begin(): void {
    const fresh = this.state.phase === 'over' ? this.make(this.seed(), this.record.streak) : this.state
    this.state = start(fresh)
    this.loop.start()
    this.paint()
  }

  /** one frame of the loop: the held keys and the presses since the last frame are the input; the loop goes on while the game is live and in a battle */
  private advance(dt: number): boolean {
    this.banner = Math.max(0, this.banner - dt)
    const held = (code: string): boolean => this.held.has(code)
    const pressed = (code: string): boolean => this.pressed.has(code)
    const digit = DIGIT_KEYS.findIndex((code) => pressed(code))
    const input: ArtilleryInput = {
      left: held('ArrowLeft'),
      right: held('ArrowRight'),
      up: held('ArrowUp'),
      down: held('ArrowDown'),
      fire: held('Space') || pressed('Space'),
      jump: pressed('Enter') || pressed('NumpadEnter'),
      pick: digit < 0 ? null : WEAPONS[digit].id,
      cycle: pressed('Tab') ? (this.tabBack ? -1 : 1) : 0
    }
    this.pressed.clear()
    const prev = this.state
    const next = step(prev, input, dt, driveBot)
    this.state = next
    if (prev.phase !== 'over' && next.phase === 'over' && next.result !== null) {
      this.record = tally(this.record, next.result)
      this.changed()
    }
    this.paint()
    return this.live && inBattle(this.state)
  }

  private paint(): void {
    const s = this.state
    this.noteTurn(s)
    this.frames++
    const active = s.fighters[s.active]
    const ammo = ammoText(s.ammo[s.team][s.weapon])
    const d = this.el.dataset
    d.phase = s.phase
    d.turn = s.team === 'clawd' ? 'you' : 'bot'
    d.weapon = s.weapon
    d.ammo = ammo
    d.x = String(Math.round(active.x))
    d.air = String(active.air)
    d.time = String(Math.ceil(s.clock))
    d.wind = String(Math.round(s.wind))
    d.hp = `${Math.round(teamHp(s, 'clawd'))}/${Math.round(teamHp(s, 'bug'))}`
    d.camera = String(Math.round(s.camera))
    this.paintHud(s)
    this.paintWeapons(s)
    this.paintInfo(s, ammo)
    this.hint.textContent = hintText(s)
    this.message.textContent = this.messageText(s)
    this.message.hidden = this.message.textContent === ''
    this.syncGround(s)
    this.drawField(s)
    this.drawMini(s)
  }

  /** a team's HUD: the HP bar and the total, the bar first for the Clawds and the total first for the bugs */
  private teamHud(side: Team): TeamHud {
    const fill = el('div', 'artillery-bar-fill')
    const bar = el('div', 'artillery-bar')
    bar.append(fill)
    const num = el('span', 'artillery-num')
    const box = el('div', `artillery-team ${side}`)
    box.append(...(side === 'clawd' ? [bar, num] : [num, bar]))
    return { box, num, fill }
  }

  private paintHud(s: ArtilleryState): void {
    const full = ARTILLERY.hp * TEAM_SIZE
    const clawds = teamHp(s, 'clawd')
    const bugs = teamHp(s, 'bug')
    this.clawdHud.fill.style.width = `${(clawds / full) * 100}%`
    this.clawdHud.num.textContent = String(Math.round(clawds))
    this.bugHud.fill.style.width = `${(bugs / full) * 100}%`
    this.bugHud.num.textContent = String(Math.round(bugs))
    this.wind.textContent = windArrows(s.wind)
    this.time.textContent = s.team === 'clawd' ? clockText(s.clock) : 'bot'
    this.flood.hidden = s.turn < ARTILLERY.floodFrom
  }

  /** the weapon strip: the chosen weapon, the empty ones dimmed; on the bugs' turn the strip is dimmed and shows their choice */
  private paintWeapons(s: ArtilleryState): void {
    const row = s.ammo[s.team]
    this.strip.classList.toggle('bot', s.team === 'bug')
    WEAPONS.forEach((w, i) => {
      const left = row[w.id]
      const { cell, ammo } = this.weapons[i]
      cell.classList.toggle('chosen', w.id === s.weapon)
      cell.classList.toggle('empty', left <= 0)
      ammo.textContent = ammoText(left)
    })
  }

  private paintInfo(s: ArtilleryState, ammo: string): void {
    const def = WEAPONS.find((w) => w.id === s.weapon)!
    this.name.textContent = `${def.name} · ${ammo}`
    const lit = Math.round(s.power * POWER_CELLS)
    const power = def.power ? ` · power ${'▮'.repeat(lit)}${'▯'.repeat(POWER_CELLS - lit)}` : ''
    this.aim.textContent = `aim ${Math.round(s.aim)}°${power}`
  }

  /** a new turn (or a new battle) shows its banner for BANNER_TIME seconds */
  private noteTurn(s: ArtilleryState): void {
    const key = `${s.battle}:${s.turn}:${s.team}`
    if (key !== this.turnKey) {
      this.turnKey = key
      this.banner = BANNER_TIME
    }
  }

  /** the message over the field: the title, the turn's banner, or the end of the battle with the record */
  private messageText(s: ArtilleryState): string {
    const line = `wins ${fmt(this.record.wins)} · streak ${fmt(this.record.streak)} · best ${fmt(this.record.best)}`
    if (s.phase === 'title') return `Space to start\n${line}`
    if (s.phase === 'over') {
      const head = s.result === 'win' ? 'You win!' : s.result === 'loss' ? 'Bugs win' : 'Draw'
      return `${head}\n${line}\nSpace for a new battle`
    }
    if (this.banner > 0 && (s.phase === 'aim' || s.phase === 'bot')) {
      const turn = s.team === 'clawd' ? 'Your turn' : "Bugs' turn"
      return s.turn >= ARTILLERY.floodFrom ? `${turn} · water rising` : turn
    }
    return ''
  }

  /** the offscreen ground follows the battle: the whole map when a new battle starts, else each new carved box with 2 cells around it */
  private syncGround(s: ArtilleryState): void {
    const g = s.ground
    if (this.paintedBattle !== s.battle) {
      this.paintedBattle = s.battle
      this.paintedCarved = 0
      this.paintGround(g, 0, 0, g.w - 1, g.h - 1)
    }
    for (; this.paintedCarved < s.carved.length; this.paintedCarved++) {
      const b = s.carved[this.paintedCarved]
      this.paintGround(g, Math.max(0, b.x0 - 2), Math.max(0, b.y0 - 2), Math.min(g.w - 1, b.x1 + 2), Math.min(g.h - 1, b.y1 + 2))
    }
  }

  /** paints the box x0…x1, y0…y1 (inclusive map cells) of the ground: cleared, then the body in runs, a lighter top edge, darker sides and a sparse texture */
  private paintGround(g: Ground, x0: number, y0: number, x1: number, y1: number): void {
    const ctx = this.groundCtx
    const c = this.colors
    ctx.clearRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    ctx.fillStyle = c.raised2
    for (let y = y0; y <= y1; y++) {
      let run = -1
      for (let x = x0; x <= x1 + 1; x++) {
        const on = x <= x1 && isGround(g, x, y)
        if (on && run < 0) run = x
        else if (!on && run >= 0) {
          ctx.fillRect(run, y, x - run, 1)
          run = -1
        }
      }
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!isGround(g, x, y)) continue
        if (!isGround(g, x, y - 1)) {
          ctx.fillStyle = c.line3
          ctx.fillRect(x, y, 1, 2)
        } else if (!isGround(g, x - 1, y) || !isGround(g, x + 1, y)) {
          ctx.fillStyle = c.well
          ctx.fillRect(x, y, 1, 1)
        } else if (speckled(x, y)) {
          ctx.fillStyle = c.raised
          ctx.fillRect(x, y, 1, 1)
        }
      }
    }
  }

  /** the field: the view's part of the map, the water, the blasts and shots, the fighters, and the aim before the use */
  private drawField(s: ArtilleryState): void {
    const ctx = this.ctx
    const c = this.colors
    const V = ARTILLERY.view
    const H = ARTILLERY.height
    const cam = Math.round(s.camera)
    ctx.fillStyle = c.well
    ctx.fillRect(0, 0, V, H)
    ctx.fillStyle = c.line2
    for (const star of STARS) {
      const sx = star.x - cam
      if (sx >= 0 && sx < V) ctx.fillRect(sx, star.y, 1, 1)
    }
    ctx.drawImage(this.ground, cam, 0, V, H, 0, 0, V, H)

    ctx.save()
    ctx.translate(-cam, 0)
    this.drawWater(s, cam)
    for (const b of s.blasts) {
      ctx.globalAlpha = 0.8 * Math.max(0, b.left / ARTILLERY.blastTime)
      ctx.fillStyle = c.amber
      ctx.beginPath()
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    for (const shot of s.shots) {
      if (shot.y < 0) {
        // a shot above the top of the map is off the field: a marker at the top edge shows where it is
        ctx.fillStyle = c.text
        ctx.font = `10px ${MONO}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText('^', shot.x, 0)
      } else {
        ctx.fillStyle = shot.fuse !== null ? c.amber : c.text
        ctx.fillRect(Math.round(shot.x) - 1, Math.round(shot.y) - 1, 2, 2)
      }
    }
    this.drawFighters(s)
    if ((s.phase === 'aim' || s.phase === 'bot') && !s.used) this.drawAim(s)
    ctx.restore()
  }

  private drawWater(s: ArtilleryState, cam: number): void {
    const ctx = this.ctx
    const c = this.colors
    ctx.globalAlpha = 0.2
    ctx.fillStyle = c.blue
    ctx.fillRect(cam, s.water, ARTILLERY.view, ARTILLERY.height - s.water)
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.moveTo(cam, s.water)
    for (let x = cam; x <= cam + ARTILLERY.view; x += 4) ctx.lineTo(x, s.water + Math.sin((x + this.frames) / 4))
    ctx.strokeStyle = c.blue
    ctx.lineWidth = 1
    ctx.stroke()
  }

  /** each living fighter as its sprite, its HP over it, a ▼ (or a … while the bot plans) over the one whose turn it is */
  private drawFighters(s: ArtilleryState): void {
    const ctx = this.ctx
    const c = this.colors
    ctx.font = `9px ${MONO}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    s.fighters.forEach((g, i) => {
      if (g.out) return
      const x = Math.round(g.x)
      const y = Math.round(g.y)
      const color = g.team === 'clawd' ? c.accent : c.purple
      if (g.team === 'clawd') paintSprite(ctx, CLAWD, x - 9, y - 9, 1, color)
      else paintPixels(ctx, BUG, x - 7, y - 9, color)
      ctx.fillStyle = color
      ctx.fillText(String(Math.ceil(g.hp)), x, y - 11)
      if (i === s.active) {
        ctx.fillStyle = c.text
        ctx.fillText(s.bot?.stage === 'think' ? '…' : '▼', x, y - 20)
      }
    })
  }

  /** the aim before the use: a dotted line from the muzzle with a crosshair at its end, or the cursor's crosshair */
  private drawAim(s: ArtilleryState): void {
    const ctx = this.ctx
    const c = this.colors
    if (s.cursor !== null) {
      // a Teleport to a spot that would be refused is shown in red
      const refused = s.weapon === 'teleport' && !teleportOk(s.ground, s.water, Math.round(s.cursor.x), Math.round(s.cursor.y))
      crosshair(ctx, s.cursor.x, s.cursor.y, refused ? c.red : c.accent)
      return
    }
    const f = s.fighters[s.active]
    const { dx, dy } = aimVector(f, s.aim)
    const x0 = f.x + dx * ARTILLERY.muzzle
    const y0 = f.y - 5 + dy * ARTILLERY.muzzle
    ctx.fillStyle = c.text
    for (let t = 0; t <= AIM_LEN; t += 4) ctx.fillRect(Math.round(x0 + dx * t), Math.round(y0 + dy * t), 1, 1)
    crosshair(ctx, x0 + dx * AIM_LEN, y0 + dy * AIM_LEN, c.accent)
  }

  /** the minimap: the map at a third of its size from the minimap's top row, the water, a dot per fighter, and a frame on the part the field shows */
  private drawMini(s: ArtilleryState): void {
    const ctx = this.miniCtx
    const c = this.colors
    const V = ARTILLERY.view
    const top = ARTILLERY.minimapTop
    ctx.fillStyle = c.well
    ctx.fillRect(0, 0, V, MINI_H)
    ctx.drawImage(this.ground, 0, top, ARTILLERY.width, ARTILLERY.height - top, 0, 0, V, MINI_H)
    const waterTop = (s.water - top) / MINI
    ctx.globalAlpha = 0.5
    ctx.fillStyle = c.blue
    ctx.fillRect(0, waterTop, V, MINI_H - waterTop)
    ctx.globalAlpha = 1
    for (const g of s.fighters) {
      if (g.out) continue
      ctx.fillStyle = g.team === 'clawd' ? c.accent : c.purple
      ctx.fillRect(Math.round(g.x / MINI) - 1, Math.round((g.y - top) / MINI) - 1, 3, 3)
    }
    ctx.strokeStyle = c.text3
    ctx.lineWidth = 1
    ctx.strokeRect(s.camera / MINI + 0.5, 0.5, V / MINI - 1, MINI_H - 1)
  }
}
