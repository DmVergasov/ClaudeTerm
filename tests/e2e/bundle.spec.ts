import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ROOT } from './helpers'

// the Agent SDK is loaded at run time, by the one dynamic import in sdk-engine.ts, so the build keeps it external. The
// pinned version and the platform packages left out are pinned by tests/unit/third-party-notices.test.ts (lines 20-25).
test('the Agent SDK stays out of the main bundle', () => {
  const text = readFileSync(join(ROOT, 'out', 'main', 'index.js'), 'utf8')
  expect(text).toMatch(/(import|require)\(\s*["']@anthropic-ai\/claude-agent-sdk["']\s*\)/)
})
