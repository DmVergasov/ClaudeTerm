import { describe, expect, it } from 'vitest'
import { CHECK_EVERY_MS, FIRST_CHECK_MS, Updater, type UpdaterBackend } from '../../src/main/updater'
import type { UpdateState } from '../../src/shared/types'

function fakeBackend() {
  const h: { downloaded?: (v: string) => void; error?: (m: string) => void } = {}
  const b = {
    result: null as string | null,
    fail: null as string | null,
    checks: 0,
    installs: 0,
    pending: null as null | (() => void),
    hold: false,
    check(): Promise<string | null> {
      b.checks++
      if (b.hold) return new Promise((res) => { b.pending = () => res(b.result) })
      return b.fail ? Promise.reject(new Error(b.fail)) : Promise.resolve(b.result)
    },
    onDownloaded: (cb: (v: string) => void) => { h.downloaded = cb },
    onError: (cb: (m: string) => void) => { h.error = cb },
    quitAndInstall: () => { b.installs++ }
  }
  return { b: b as typeof b & UpdaterBackend, h }
}

function setup(o: { backend?: boolean; enabled?: boolean } = {}) {
  const { b, h } = fakeBackend()
  const timers: { fn: () => void; ms: number }[] = []
  const out: string[] = []
  const states: UpdateState[] = []
  const flags = { enabled: o.enabled ?? true }
  const u = new Updater({
    backend: o.backend === false ? null : b,
    currentVersion: '0.1.3',
    enabled: () => flags.enabled,
    publish: (s) => states.push(s),
    notify: (m) => out.push(`toast:${m}`),
    beforeInstall: () => out.push('beforeInstall'),
    log: (m) => out.push(`log:${m}`),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => { timers.length = 0 }
  })
  return { u, b, h, timers, out, states, flags }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('Updater', () => {
  it('checks 15 s after start and then every 4 hours, only while enabled', async () => {
    const { u, b, timers, flags } = setup()
    u.start()
    expect(timers.map((t) => t.ms)).toEqual([FIRST_CHECK_MS])
    timers.shift()!.fn()
    await flush()
    expect(b.checks).toBe(1)
    expect(timers.map((t) => t.ms)).toEqual([CHECK_EVERY_MS])
    flags.enabled = false
    timers.shift()!.fn()
    await flush()
    expect(b.checks).toBe(1)
    expect(timers.map((t) => t.ms)).toEqual([CHECK_EVERY_MS])
  })

  it('a manual check reports the result', async () => {
    const { u, b, out } = setup()
    await u.check(true)
    b.result = '0.1.4'
    await u.check(true)
    expect(out).toEqual(['toast:Установлена последняя версия (0.1.3)', 'toast:Загружается ClaudeTerm 0.1.4…'])
  })

  it('background errors are only logged; manual errors are shown', async () => {
    const { u, b, out } = setup()
    b.fail = 'net::ERR_INTERNET_DISCONNECTED'
    await u.check(false)
    await u.check(true)
    expect(out).toEqual(['log:update check failed: net::ERR_INTERNET_DISCONNECTED', 'toast:Не удалось проверить обновления: net::ERR_INTERNET_DISCONNECTED'])
  })

  it('a check while another is running is ignored', async () => {
    const { u, b, out } = setup()
    b.hold = true
    const first = u.check(false)
    await u.check(true)
    b.pending!()
    await first
    expect(b.checks).toBe(1)
    expect(out).toEqual([])
  })

  it('a downloaded update becomes the ready state; a manual check then asks for a restart instead of checking', async () => {
    const { u, b, h, out, states } = setup()
    h.downloaded!('0.1.4')
    expect(states).toEqual([{ status: 'ready', version: '0.1.4' }])
    expect(u.current).toEqual({ status: 'ready', version: '0.1.4' })
    await u.check(true)
    expect(b.checks).toBe(0)
    expect(out).toEqual(['toast:ClaudeTerm 0.1.4 уже загружена — нажмите «Перезапустить»'])
  })

  it('install saves the session before quitting into the installer, and only when ready', () => {
    const { u, b, h, out } = setup()
    u.install()
    expect(b.installs).toBe(0)
    h.downloaded!('0.1.4')
    u.install()
    expect(out).toEqual(['beforeInstall'])
    expect(b.installs).toBe(1)
  })

  it('backend errors (e.g. a failed download) are logged', () => {
    const { h, out } = setup()
    h.error!('sha512 checksum mismatch')
    expect(out).toEqual(['log:update error: sha512 checksum mismatch'])
  })

  it('without a backend: manual check explains, background does nothing, start schedules nothing', async () => {
    const { u, out, timers } = setup({ backend: false })
    u.start()
    await u.check(false)
    await u.check(true)
    expect(timers).toEqual([])
    expect(out).toEqual(['toast:Обновления работают только в установленной версии'])
  })

  it('stop cancels the schedule', () => {
    const { u, timers } = setup()
    u.start()
    u.stop()
    expect(timers).toEqual([])
  })
})
