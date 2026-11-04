import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type DocEntry, docUrl } from '../../src/main/doc-hub'
import { nodeDocFs, resolveDocRequest } from '../../src/main/doc-protocol'

const ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b'
let dir: string
let report: string
let doc: DocEntry

function entryFor(root: string, relPath: string): DocEntry {
  const path = join(root, relPath)
  return { id: ID, path, relPath, name: relPath, title: null, kind: 'html', url: docUrl(ID, root, path), tabId: 't1', root }
}

const find = (id: string): DocEntry | undefined => (id === ID ? doc : undefined)

beforeAll(() => {
  // the real folder, then a junction to it: the document's root is the alias, a spelling that is not the real path
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ct-docproto-')))
  report = join(dir, 'report')
  mkdirSync(join(report, 'assets'), { recursive: true })
  writeFileSync(join(report, 'index.html'), '<p>hi</p>')
  writeFileSync(join(report, 'assets', 'app.js'), 'x')
  writeFileSync(join(dir, 'secret.txt'), 'secret')
  symlinkSync(dir, join(report, 'up'), 'junction')
  const alias = join(dir, 'alias')
  symlinkSync(report, alias, 'junction')
  doc = entryFor(alias, 'index.html')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('resolveDocRequest on disk', () => {
  it('serves the report itself, through a root given by a junction', async () => {
    // the own file is served at its own path, which the junction makes the real report file
    const hit = await resolveDocRequest(`ctdoc://${ID}/index.html`, find, nodeDocFs)
    expect(hit?.doc).toBe(doc)
    expect(realpathSync(hit!.path)).toBe(realpathSync(join(report, 'index.html')))
  })

  it('serves a file under the report folder at its real path, when the root is a junction', async () => {
    expect(await resolveDocRequest(`ctdoc://${ID}/assets/app.js`, find, nodeDocFs)).toEqual({ path: realpathSync(join(report, 'assets', 'app.js')), doc })
  })

  it('refuses a file reached through a junction that leads out of the folder', async () => {
    expect(await resolveDocRequest(`ctdoc://${ID}/up/secret.txt`, find, nodeDocFs)).toBeNull()
  })
})
