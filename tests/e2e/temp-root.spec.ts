import { expect, test } from '@playwright/test'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { TEMP_ROOT_PREFIX } from '../fixtures/temp-root'
import { launchApp } from './helpers'

test('the app a test starts keeps its data folder and its temp files in the run\'s temp root, which the run deletes', async () => {
  expect(basename(tmpdir()).startsWith(TEMP_ROOT_PREFIX)).toBe(true)
  const { app, dataDir } = await launchApp()
  expect(dirname(dataDir)).toBe(tmpdir())
  // the app's own temp files (images, the clipboard) go where its TEMP, TMP and TMPDIR say
  expect(await app.evaluate(() => [process.env.TEMP, process.env.TMP, process.env.TMPDIR])).toEqual([tmpdir(), tmpdir(), tmpdir()])
  await app.close()
})
