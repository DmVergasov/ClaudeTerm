import { describe, expect, it } from 'vitest'
import { DEFAULT_TEST_PATTERNS, testMatcher } from '../../src/shared/test-files'

const isTest = testMatcher(DEFAULT_TEST_PATTERNS)

describe('testMatcher with the default patterns', () => {
  it.each([
    'tests/x.py', 'test/a.ts', 'src/tests/a.ts', 'src/Tests/Foo.cpp', 'Source/Test/Foo.cpp', 'a/__tests__/b.js', 'spec/a.rb', 'x/e2e/login.ts',
    'a.test.ts', 'src/a.spec.js', 'pkg/foo_test.go', 'tools/test_parse.py', 'src/VehicleTest.cpp', 'src/VehicleTests.cpp', 'Test.cpp'
  ])('%s is a test', (path) => { expect(isTest(path)).toBe(true) })

  it.each([
    'src/a.ts', 'Contest.cpp', 'src/contest/a.ts', 'latest.txt', 'src/testing/a.ts', 'src/protests.ts', 'test.ts', 'a/attest/b.ts', 'testdata_a.py'
  ])('%s is not a test', (path) => { expect(isTest(path)).toBe(false) })

  it('is case-sensitive', () => {
    expect(isTest('TESTS/a.ts')).toBe(false)
    expect(isTest('src/a.TEST.ts')).toBe(false)
  })

  it('reads backslashes as separators', () => {
    expect(isTest('src\\Tests\\Foo.cpp')).toBe(true)
    expect(isTest('src\\Foo.cpp')).toBe(false)
  })
})

describe('testMatcher globs', () => {
  it('* and ? stay inside one name', () => {
    const m = testMatcher(['src/*.ts', 'lib/a?.js'])
    expect(m('src/a.ts')).toBe(true)
    expect(m('src/deep/a.ts')).toBe(false)
    expect(m('lib/ab.js')).toBe(true)
    expect(m('lib/abc.js')).toBe(false)
    expect(m('lib/a/.js')).toBe(false)
  })

  it('** crosses folders: **/x also matches x at the root, x/** matches what is under x', () => {
    const m = testMatcher(['**/gen/**', 'docs/**', '**/x.ts'])
    expect(m('gen/a.ts')).toBe(true)
    expect(m('a/b/gen/c/d.ts')).toBe(true)
    expect(m('docs/a/b.md')).toBe(true)
    expect(m('docs')).toBe(false)
    expect(m('other/docs/a.md')).toBe(false)
    expect(m('x.ts')).toBe(true)
    expect(m('a/b/x.ts')).toBe(true)
  })

  it('a pattern without / matches the file name in any folder, not a folder name', () => {
    const m = testMatcher(['fixtures', '*.snap'])
    expect(m('a/b/fixtures')).toBe(true)
    expect(m('fixtures/a.ts')).toBe(false)
    expect(m('a/__snapshots__/x.snap')).toBe(true)
  })

  it('takes regular expression characters literally', () => {
    const m = testMatcher(['a+b(1).ts', '[x].ts'])
    expect(m('a+b(1).ts')).toBe(true)
    expect(m('aab(1).ts')).toBe(false)
    expect(m('[x].ts')).toBe(true)
    expect(m('x.ts')).toBe(false)
  })

  it('no patterns, and empty ones, match nothing', () => {
    expect(testMatcher([])('tests/a.ts')).toBe(false)
    expect(testMatcher(['', '  '])('tests/a.ts')).toBe(false)
  })
})

describe('testMatcher cost', () => {
  const within = (ms: number, f: () => void): void => {
    const t = performance.now()
    f()
    expect(performance.now() - t).toBeLessThan(ms)
  }

  it('a pattern full of stars does not make the match slow', () => {
    const name = 'ab_'.repeat(21) + 'x'
    within(50, () => expect(testMatcher(['*_*_*_*_*_*_*_*_*Z'])(`src/${name}`)).toBe(false))
    within(50, () => expect(testMatcher(['*_*_*_*_*_*_*_*_*_*_*_*x'])(`src/${name}`)).toBe(true))
  })

  it('a chain of ** segments does not make the match slow', () => {
    const deep = Array.from({ length: 16 }, (_, i) => `d${i}`).join('/') + '/file.ts'
    within(50, () => expect(testMatcher([`${'**/'.repeat(14)}nomatch`])(deep)).toBe(false))
    within(50, () => expect(testMatcher([`${'**/x/'.repeat(8)}nomatch`])(deep)).toBe(false))
    expect(testMatcher(['**/**/**/file.ts'])(deep)).toBe(true)
  })
})

describe('testMatcher folder spellings', () => {
  it('a leading ./ is dropped', () => {
    const m = testMatcher(['./tests/**', './*.spec.ts'])
    expect(m('tests/a.ts')).toBe(true)
    expect(m('src/tests/a.ts')).toBe(false)
    expect(m('a.spec.ts')).toBe(true)
  })

  it('a trailing / means the folder and everything under it', () => {
    const m = testMatcher(['tests/', 'src/gen/'])
    expect(m('tests/a.ts')).toBe(true)
    expect(m('x/y/tests/a.ts')).toBe(true)
    expect(m('tests')).toBe(false)
    expect(m('src/gen/a/b.ts')).toBe(true)
    expect(m('lib/src/gen/a.ts')).toBe(false)
    expect(m('src/a.ts')).toBe(false)
  })
})
