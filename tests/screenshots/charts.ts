// Demo charts for the README images and GIFs: invented revenue numbers, drawn in the renderer.
import type { Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']
export const REVENUE_2025 = [160, 168, 175, 171, 190, 198, 214, 220, 228]
export const REVENUE_2026 = [182, 195, 210, 204, 228, 241, 276, 289, 301]

export interface ChartSpec {
  title: string
  subtitle: string
  kind: 'bars' | 'lines'
  labels: string[]
  series: { name: string; color: string; values: number[] }[]
}

// Runs in the renderer (serialized by Playwright): must not reference anything outside itself.
export function drawChart(s: ChartSpec): string {
  const W = 1600
  const H = 1000
  const L = 130
  const R = 70
  const T = 190
  const B = 110
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = '#16161a'
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#ececef'
  g.font = '600 54px "Segoe UI", sans-serif'
  g.fillText(s.title, L, 96)
  g.fillStyle = '#8a8a93'
  g.font = '32px "Segoe UI", sans-serif'
  g.fillText(s.subtitle, L, 146)
  let lx = W - R
  g.font = '30px "Segoe UI", sans-serif'
  for (const ser of [...s.series].reverse()) {
    const w = g.measureText(ser.name).width
    lx -= w
    g.fillStyle = '#b8b8c0'
    g.fillText(ser.name, lx, 100)
    lx -= 34
    g.fillStyle = ser.color
    g.beginPath()
    g.arc(lx + 12, 90, 11, 0, Math.PI * 2)
    g.fill()
    lx -= 36
  }
  const max = Math.max(...s.series.flatMap((x) => x.values)) * 1.15
  const pw = W - L - R
  const ph = H - T - B
  const y = (v: number): number => T + ph - (v / max) * ph
  g.lineWidth = 2
  g.font = '26px "Segoe UI", sans-serif'
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4
    g.strokeStyle = '#2a2a31'
    g.beginPath()
    g.moveTo(L, y(v))
    g.lineTo(W - R, y(v))
    g.stroke()
    g.fillStyle = '#6f6f78'
    g.textAlign = 'right'
    g.fillText(`$${Math.round(v)}k`, L - 18, y(v) + 9)
  }
  const step = pw / s.labels.length
  g.textAlign = 'center'
  g.fillStyle = '#8a8a93'
  s.labels.forEach((lab, i) => g.fillText(lab, L + step * (i + 0.5), H - B + 52))
  g.textAlign = 'left'
  if (s.kind === 'bars') {
    const bw = (step * 0.62) / s.series.length
    s.series.forEach((ser, j) =>
      ser.values.forEach((v, i) => {
        g.fillStyle = ser.color
        g.beginPath()
        g.roundRect(L + step * i + step * 0.19 + bw * j, y(v), bw - 8, T + ph - y(v), [12, 12, 0, 0])
        g.fill()
      })
    )
  } else {
    for (const ser of s.series) {
      const pts = ser.values.map((v, i) => [L + step * (i + 0.5), y(v)] as const)
      const fill = g.createLinearGradient(0, T, 0, T + ph)
      fill.addColorStop(0, `${ser.color}44`)
      fill.addColorStop(1, `${ser.color}00`)
      g.fillStyle = fill
      g.beginPath()
      g.moveTo(pts[0][0], T + ph)
      for (const [px, py] of pts) g.lineTo(px, py)
      g.lineTo(pts[pts.length - 1][0], T + ph)
      g.fill()
      g.strokeStyle = ser.color
      g.lineWidth = 7
      g.lineJoin = 'round'
      g.beginPath()
      pts.forEach(([px, py], i) => (i === 0 ? g.moveTo(px, py) : g.lineTo(px, py)))
      g.stroke()
      g.fillStyle = ser.color
      for (const [px, py] of pts) {
        g.beginPath()
        g.arc(px, py, 10, 0, Math.PI * 2)
        g.fill()
      }
    }
  }
  return c.toDataURL('image/png').slice('data:image/png;base64,'.length)
}

export async function chart(page: Page, file: string, spec: ChartSpec): Promise<void> {
  writeFileSync(file, Buffer.from(await page.evaluate(drawChart, spec), 'base64'))
}
