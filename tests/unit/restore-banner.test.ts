import { describe, expect, it } from 'vitest'
import { plural } from '../../src/renderer/restore-banner'

describe('plural', () => {
  it('uses Russian plural forms for tabs', () => {
    expect([1, 2, 4, 5, 11, 12, 21, 22, 25].map(plural)).toEqual(['вкладка', 'вкладки', 'вкладки', 'вкладок', 'вкладок', 'вкладок', 'вкладка', 'вкладки', 'вкладок'])
  })
})
