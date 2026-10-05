// Renders docs/images/logo.svg into build/icon.png, which electron-builder turns into the app and installer icon.
import { test } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchApp } from '../e2e/helpers'

const ROOT = resolve(__dirname, '..', '..')

test('app icon', async () => {
  const { app, page } = await launchApp()
  const svg = readFileSync(resolve(ROOT, 'docs', 'images', 'logo.svg'), 'utf8')
  const png = await page.evaluate(async (source) => {
    const img = new Image()
    img.src = `data:image/svg+xml;base64,${btoa(source)}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = 512
    c.height = 512
    c.getContext('2d')!.drawImage(img, 0, 0, 512, 512)
    return c.toDataURL('image/png').slice('data:image/png;base64,'.length)
  }, svg)
  writeFileSync(resolve(ROOT, 'build', 'icon.png'), Buffer.from(png, 'base64'))
  await app.close()
})
