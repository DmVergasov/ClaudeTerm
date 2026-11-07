import { describe, expect, it } from 'vitest'
import { screenWorkerPath } from '../../src/main/sync/mirror-port'

describe('screenWorkerPath', () => {
  it('screenWorkerPath points a packaged worker at the unpacked folder and leaves a dev build alone', () => {
    expect(screenWorkerPath('C:\\Apps\\ClaudeTerm\\resources\\app.asar\\out\\main\\screen-worker-x.js')).toBe('C:\\Apps\\ClaudeTerm\\resources\\app.asar.unpacked\\out\\main\\screen-worker-x.js')
    expect(screenWorkerPath('/opt/ClaudeTerm/resources/app.asar/out/main/screen-worker-x.js')).toBe('/opt/ClaudeTerm/resources/app.asar.unpacked/out/main/screen-worker-x.js')
    expect(screenWorkerPath('/src/ct/out/main/screen-worker-x.js')).toBe('/src/ct/out/main/screen-worker-x.js')
  })
})
