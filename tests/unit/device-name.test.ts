import { describe, expect, it } from 'vitest'
import { isDeviceName, MAX_DEVICE_NAME } from '../../src/shared/devices'

describe('isDeviceName', () => {
  it('a device name is 1 to MAX_DEVICE_NAME characters, and none of them a control character', () => {
    expect(isDeviceName('Laptop')).toBe(true)
    expect(isDeviceName('Studio · Desk')).toBe(true)
    expect(isDeviceName('x'.repeat(MAX_DEVICE_NAME))).toBe(true)
    expect(isDeviceName('')).toBe(false)
    expect(isDeviceName('x'.repeat(MAX_DEVICE_NAME + 1))).toBe(false)
    expect(isDeviceName('Lap\ntop')).toBe(false)
    expect(isDeviceName('Lap\rtop')).toBe(false)
    expect(isDeviceName('Lap\u0007top')).toBe(false)
    expect(isDeviceName('Lap\u007ftop')).toBe(false)
    expect(isDeviceName(7)).toBe(false)
    expect(isDeviceName(null)).toBe(false)
  })
})
