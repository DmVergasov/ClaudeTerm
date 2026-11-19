import { describe, expect, it } from 'vitest'
import { SNAPSHOT_LIMIT, formatSnapshot } from '../../src/main/browser/snapshot'
import type { AXNode } from '../../src/main/browser/snapshot'
import ax from '../fixtures/ax-tree-login.json'

const nodes = ax as AXNode[]

describe('formatSnapshot: the login fixture', () => {
  it('prints the accessibility tree as text with refs', () => {
    const expected = [
      '- heading "Sign in" [level=1] [ref=e1]',
      '- text: "Use your work account."',
      '- textbox "Email": "ada@example.test" [ref=e2]',
      '- textbox "Password" [ref=e3]',
      '- checkbox "Remember me" [checked] [ref=e4]',
      '- button "Sign in" [ref=e5]',
      '- link "Forgot password?" [ref=e6]',
      '- group "Other ways"',
      '  - link "Sign in with SSO" [ref=e7]',
      '    - text: "Use single sign-on"',
      '- text: "Need help? Ask the admin desk."',
    ].join('\n')
    const snap = formatSnapshot(nodes)
    expect(snap.text).toBe(expected)
    expect(snap.truncated).toBe(false)
  })

  it('maps the refs e1 to e7 to the backend ids of the printed nodes, in document order', () => {
    const snap = formatSnapshot(nodes)
    expect([...snap.refs.entries()]).toEqual([
      ['e1', 101],
      ['e2', 102],
      ['e3', 103],
      ['e4', 104],
      ['e5', 105],
      ['e6', 106],
      ['e7', 107],
    ])
  })

  it('does not print a StaticText whose name equals its button name', () => {
    const snap = formatSnapshot(nodes)
    expect(snap.text).not.toContain('text: "Sign in"')
  })

  it('cuts the snapshot at a limit of 120 and ends with the cut line', () => {
    const snap = formatSnapshot(nodes, 120)
    expect(snap.truncated).toBe(true)
    expect(snap.text).toBe([
      '- heading "Sign in" [level=1] [ref=e1]',
      '- text: "Use your work account."',
      '- textbox "Email": "ada@example.test" [ref=e2]',
      '- … (snapshot cut at 120 characters; use browser_evaluate or browser_take_screenshot for the rest)',
    ].join('\n'))
  })

  it('uses SNAPSHOT_LIMIT by default', () => {
    expect(SNAPSHOT_LIMIT).toBe(60_000)
    expect(formatSnapshot(nodes).truncated).toBe(false)
  })
})

describe('formatSnapshot: names and values', () => {
  it('cuts a name to 200 code points with an ellipsis', () => {
    const tree: AXNode[] = [
      { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', ignored: false, role: { value: 'button' }, name: { value: 'a'.repeat(250) }, backendDOMNodeId: 7 },
    ]
    expect(formatSnapshot(tree).text).toBe(`- button "${'a'.repeat(199)}…" [ref=e1]`)
  })

  it('cuts a value to 200 code points with an ellipsis', () => {
    const tree: AXNode[] = [
      { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', ignored: false, role: { value: 'textbox' }, value: { value: 'b'.repeat(250) } },
    ]
    expect(formatSnapshot(tree).text).toBe(`- textbox: "${'b'.repeat(199)}…"`)
  })
})

describe('formatSnapshot: flags, value roles and skipped roles', () => {
  const root: AXNode = { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, childIds: [] }

  it('prints disabled, expanded and selected in that order, and no false flag', () => {
    const tree: AXNode[] = [
      { ...root, childIds: ['2'] },
      {
        nodeId: '2', parentId: '1', ignored: false, role: { value: 'button' }, name: { value: 'Menu' },
        properties: [
          { name: 'selected', value: { type: 'boolean', value: true } },
          { name: 'expanded', value: { type: 'boolean', value: true } },
          { name: 'disabled', value: { type: 'boolean', value: true } },
          { name: 'checked', value: { type: 'boolean', value: false } },
        ],
      },
    ]
    expect(formatSnapshot(tree).text).toBe('- button "Menu" [disabled] [expanded] [selected]')
  })

  it('prints the value of a searchbox and of a combobox', () => {
    const tree: AXNode[] = [
      { ...root, childIds: ['2', '3'] },
      { nodeId: '2', parentId: '1', ignored: false, role: { value: 'searchbox' }, name: { value: 'Search' }, value: { value: 'ada' } },
      { nodeId: '3', parentId: '1', ignored: false, role: { value: 'combobox' }, name: { value: 'Size' }, value: { value: 'L' } },
    ]
    expect(formatSnapshot(tree).text).toBe('- searchbox "Search": "ada"\n- combobox "Size": "L"')
  })

  it('skips the roles none, InlineTextBox and LineBreak and prints their children', () => {
    const tree: AXNode[] = [
      { ...root, childIds: ['2', '3', '4', '5'] },
      { nodeId: '2', parentId: '1', ignored: false, role: { value: 'none' }, childIds: ['6'] },
      { nodeId: '3', parentId: '1', ignored: false, role: { value: 'InlineTextBox' }, name: { value: 'x' } },
      { nodeId: '4', parentId: '1', ignored: false, role: { value: 'LineBreak' } },
      { nodeId: '5', parentId: '1', ignored: false, role: { value: 'button' }, name: { value: 'Next' } },
      { nodeId: '6', parentId: '2', ignored: false, role: { value: 'button' }, name: { value: 'Save' } },
    ]
    expect(formatSnapshot(tree).text).toBe('- button "Save"\n- button "Next"')
  })

  it('stops at a cycle in childIds and at a child id that is not in the tree', () => {
    const tree: AXNode[] = [
      { ...root, childIds: ['2'] },
      { nodeId: '2', parentId: '1', ignored: false, role: { value: 'button' }, name: { value: 'Go' }, childIds: ['3', '99'] },
      { nodeId: '3', parentId: '2', ignored: false, role: { value: 'StaticText' }, name: { value: 'Ready' }, childIds: ['2'] },
    ]
    expect(formatSnapshot(tree).text).toBe('- button "Go"\n  - text: "Ready"')
  })
})

describe('formatSnapshot: the limit counts indentation', () => {
  it('cuts a nested line whose indented length passes the limit', () => {
    const tree: AXNode[] = [
      { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', ignored: false, role: { value: 'group' }, name: { value: 'A' }, childIds: ['3'] },
      { nodeId: '3', parentId: '2', ignored: false, role: { value: 'group' }, name: { value: 'B' }, childIds: ['4'] },
      { nodeId: '4', parentId: '3', ignored: false, role: { value: 'button' }, name: { value: 'C' } },
    ]
    // the lines are 11, 13 and 16 characters with their indentation: 11 + 1 + 13 = 25 fits 40, 25 + 1 + 16 = 42 does not
    const snap = formatSnapshot(tree, 40)
    expect(snap.truncated).toBe(true)
    expect(snap.text).toBe([
      '- group "A"',
      '  - group "B"',
      '- … (snapshot cut at 40 characters; use browser_evaluate or browser_take_screenshot for the rest)',
    ].join('\n'))
  })
})
