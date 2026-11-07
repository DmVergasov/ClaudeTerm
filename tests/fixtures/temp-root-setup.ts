import { closeTempRoot, openTempRoot } from './temp-root'

/**
 * The global setup of Vitest and of Playwright: the run's temp root, set before the workers start so that they and
 * everything they start inherit it. The function it returns is the global teardown, which deletes the root.
 */
export default function setup(): () => void {
  const root = openTempRoot()
  return () => closeTempRoot(root)
}
