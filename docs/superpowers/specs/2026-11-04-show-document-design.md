# show_document — design

Date: 2026-11-04
Status: the user asked for it ("давай делай show_document") after a short pitch — a document in a side panel:
Markdown formatted with comments and Send to Claude, PDF, HTML reports — and skipped the questions. Everything
not in that pitch is marked *(Claude's call)*.

## Goal

Claude puts a document in front of the user next to the terminal: a spec or a plan it wrote, a README, a coverage
or test report, a PDF. The user reads it formatted instead of as raw text in the terminal, and for Markdown leaves
comments on its blocks and sends them back to Claude in one message, the way the Changes panel does for a diff.

## Background: what exists

- The bundled MCP server `claudeterm` (`src/mcp/show-image-server.ts`) has `show_image` (→ the Media panel) and
  `show_diff` (→ the Changes panel). Each tool sends one message over the pipe (`src/shared/protocol.ts`) with the
  tab it runs in (`CLAUDETERM_TAB_ID`) and returns ClaudeTerm's answer to Claude.
- The side panel (`src/renderer/side-panel.ts`) has two tabs, Media and Changes, one shown at a time, each with its
  own width; Changes can be expanded over the whole window (⤢).
- The Changes panel formats Markdown files (`src/renderer/markdown-diff.ts`, markdown-it with raw HTML off, task
  lists, front matter as a code block) and lets the user comment on blocks and send the comments
  (`src/renderer/review-comments.ts`, `sendToClaude` in `src/renderer/main.ts`). It does so only for a file that
  changed: an unchanged README, or a file outside the repository, cannot be shown that way.
- Electron 44's own PDF viewer shows a PDF inside an `<iframe>` of a custom privileged scheme in the sandboxed window,
  without `plugins: true` (checked with a throwaway Electron script).

## The tool

`show_document` in the `claudeterm` MCP server:

- `path` — absolute (preferred) or relative to the current working directory.
- `title` — optional, a short title shown in the panel instead of the file name; at most 100 characters.

Description for Claude: *Show a document to the user in the Docs panel next to the terminal in ClaudeTerm:
Markdown (formatted; the user can comment on it and send the comments back to you), PDF or HTML (a report, a
generated page). Use it after writing a spec, a plan, a report or another document the user should read, or when the
user asks to see one.*

What the tool checks itself, before it asks ClaudeTerm:

- The type, by extension: `.md`, `.markdown` → Markdown; `.pdf` → PDF; `.html`, `.htm` → HTML. Anything else is an
  error that lists these types.
- The file exists and is a regular file.
- The size *(Claude's call)*: Markdown up to 5 MB, HTML up to 20 MB (the page file itself), PDF up to 200 MB.

Answers:

- Not in a ClaudeTerm Claude tab (no valid `CLAUDETERM_TAB_ID`): error `show_document works only in a ClaudeTerm Claude tab`.
- ClaudeTerm not running: not an error, `ClaudeTerm is not running; the document is at <path>` (as `show_image`).
- Success, Markdown: `Opened <relPath> in the Docs panel. The user can comment on it; their comments come back to you
  as a message.` PDF and HTML: `Opened <relPath> in the Docs panel.`

The pipe message is `show_document`: `{ v: 1, type: 'show_document', tabId: UUID | null, path: absolute, title:
string | null }`; the parser takes a title up to 100 characters (longer is cut) and rejects a relative path or a
non-UUID tab id.

## Main: the documents of a tab

A `DocHub` (`src/main/doc-hub.ts`) keeps each Claude tab's documents, in memory:

- An entry: `id` (a random UUID; it names the document in IPC and in `ctdoc://`), `path`, `relPath` (relative to
  the tab's folder when inside it, with `/`; the absolute path otherwise), `name` (the file name), `title`, `kind`
  (`markdown` | `pdf` | `html`), `shownAt`, and the tab's `folder`.
- Showing a document the tab already has (same file by `pathKey`) moves it to the front and takes the new title; it
  keeps its id. Newest first; at most 30 per tab *(Claude's call)*, the oldest go.
- Only a Claude tab takes documents (`show_document works only in a ClaudeTerm Claude tab` otherwise); a closed tab's
  documents go with it. Nothing is kept across a restart of ClaudeTerm.
- On every change main sends the tab's list to the renderer: `DocsUpdate { tabId, docs: DocInfo[], reveal: docId |
  null }`; `reveal` names the document `show_document` just showed.

Main checks the file again when it takes the message (exists, regular file, type) and answers the pipe with the
texts above.

## The ctdoc:// scheme

Documents reach the window only through a new privileged scheme `ctdoc` (standard, secure, fetch), the way images
use `ctimg://`:

- `ctdoc://<docId>/<path>`: `<path>` is relative to the folder of the document's file, `/`-separated and
  URL-encoded. The document itself is `ctdoc://<docId>/<its file name>`.
- What a document may load:
  - PDF: only its own file.
  - HTML: any regular file under its folder (its CSS, scripts, images, other pages of the report).
  - Markdown: image files (`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg`) under its folder or under its tab's
    folder (a spec in `docs/specs/` shows `../../images/shot.png`).
- "Under" is checked on real paths (`realpath`), with `pathKey`: a symlink or junction that leads out is refused.
  Anything else is 404.
- An HTML document's responses carry `Content-Security-Policy: default-src ctdoc://<docId> data: blob:
  'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'` and `Access-Control-Allow-Origin: *` (module
  scripts from a sandboxed frame need CORS): a report runs its own scripts, which can read the files under its folder and nothing outside it. So an HTML document whose folder is the home folder or a drive root is not shown (`show_document` answers an error): its scripts would read every file there.

## The window

- The window's Content-Security-Policy gets `ctdoc:` in `img-src` and a `frame-src ctdoc:`.
- `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` (right after the window is created): ClaudeTerm uses no WebRTC,
  and a page may send its data over UDP only through a proxy, so a report's script cannot reach the network that way
  (STUN and the like). The e2e test reads the policy back.
- Navigation: a frame other than the window's own may go only to `ctdoc://` addresses of known documents and to
  `about:blank` (`will-frame-navigate`); everything else is stopped *(Claude's call: a link out of an HTML report
  is blocked, so that a page's script cannot send what it read anywhere)*. The window's own `frame-src ctdoc:`
  stops such a navigation first: the frame shows Chromium's blocked page, and showing Docs again brings the document
  back. The PDF viewer's own frame is not a navigation of the window and keeps working (an e2e test shows the PDF
  loads).
- IPC: main checks every argument (`ipc-guards.ts`): a document id must be a UUID of a known document, an action one
  of a fixed set.

## The Docs panel

### Where

- A third tab of the side panel, **Docs**, after Changes. It can be expanded over the window (⤢) like Changes, and
  dragged up to 85% of the window. Its first width is `review.width` *(Claude's call: no new setting)*.
- A **Docs** button in the tab bar, after Changes, with a document icon. It shows only on a Claude tab that has at
  least one document *(Claude's call: no fourth always-on button)*; it is lit while Docs is shown. No badge.
- **Ctrl+Shift+O** (**⌘O** on macOS) toggles Docs on a tab that has documents *(Claude's call: O is free in both
  keymaps and the macOS menu)*.
- `show_document` in the tab in front opens the panel on Docs — from Media or Changes too — and shows that
  document. In a tab behind, this happens when the tab comes to the front (as `show_diff` does).
- When the last document of a tab is removed, Docs is not available any more and the panel falls back to Media.

### Header

- The panel title is `Docs`.
- Its tools, in order: a document selector (a `<select>`, newest first, each item the title or else the file name,
  with the relPath as its tooltip), a **⋯** menu — **Open in default app**, **Show in Explorer** (the label Media and
  Changes use), **Copy path**, **Remove from list** — and ⤢.
- Each tab remembers which of its documents is shown; it starts with the newest, and `show_document` switches to the
  one it showed.

### Markdown

- Formatted with the same markdown-it setup as Changes (raw HTML shown as text, task lists, front matter as a code
  block, links made of bare addresses). Shared code, not a copy.
- An image with a relative address is shown, loaded as `ctdoc://<docId>/<address>`; an image with any other address
  shows its text, as in Changes.
- A click on an `http(s)` link opens it in the browser; other links do nothing.
- Comments, as in a formatted file of Changes: hover a block for **+**, click it or drag it over several blocks, type,
  **Add comment** (Ctrl+Enter / ⌘Enter), Esc cancels; a comment shows under its block with **Edit** and **Delete**;
  right-click a block → **Comment**, **Open in editor at line N**, **Copy path:line**. The same look (the Changes
  panel's classes).
- A footer: `N comments` and **Send to Claude**, which writes this into Claude's prompt and presses Enter, through
  the same `sendToClaude` as Changes (so it waits for a dialog to be answered, and says why it did not send):

  ```
  Comments on docs/superpowers/specs/x-design.md:

  1. docs/superpowers/specs/x-design.md:12-14
     > the quoted lines (up to 6)
     the comment
  ```

- Comments are kept per tab and per document in the window's memory, until sent, deleted, or the document leaves the
  list. When the file changes they follow their lines, as in Changes; a comment whose lines are gone is marked
  outdated and still sent, marked so.

### PDF

An `<iframe>` of `ctdoc://<docId>/<name>`: Chromium's viewer, with its own zoom, pages and find. No comments.

### HTML

An `<iframe sandbox="allow-scripts">` of `ctdoc://<docId>/<name>`: no same origin (it cannot reach the window or
the bridge), no popups, forms or downloads; the scheme's policy keeps it inside its folder: its scripts cannot load anything from outside it, reach the window or navigate away. Links between the pages
of a report work. No comments.

### Live

While Docs shows a document, the window asks main for its stamp (modification time and size) every second
*(Claude's call)*. When it changes, a Markdown document is read and drawn again, keeping the scroll position and the
comments; a PDF or HTML frame is reloaded. When the file is gone the panel says `File not found: <path>` above the
last content it had.

## Not in this version

- Mermaid diagrams: their library would run on the file's text in the window that holds the bridge to the
  terminals; a ```` ```mermaid ```` block shows as code.
- Comments on PDF and HTML; find (Ctrl+F) in Markdown documents; links between documents opening in the panel.
- Documents kept across a restart of ClaudeTerm.
- Other types (plain text, Word); images from the internet in Markdown.

## Tests

- Unit: the pipe message's parser; the tool's handler (paths, types, sizes, answers, ClaudeTerm not running);
  `DocHub` (same file again, the cap, removal, a shell tab, a closed tab); the `ctdoc://` resolver with a fake file
  system (each kind's rules, `..`, encoded paths, unknown id); the Send message of a document; the Markdown lines of
  a document; the new shortcut in both keymaps; the IPC guards.
- Integration: the MCP server lists `show_document` and forwards a call with its path resolved; the `ctdoc://`
  resolver on a real disk with a symlink (a junction on Windows) leading out of the folder; the pipe round trip.
- End-to-end (`tests/e2e/docs.spec.ts`): `show_document` of a Markdown file opens Docs with its headings, the tab
  bar button shows and Ctrl+Shift+O toggles the panel; a comment and Send write the message into the stand-in
  `claude`; a change of the file shows in the panel; a relative image loads; a PDF loads in its frame; an HTML report
  shows its content in a sandboxed frame and its script cannot load a file outside its folder; two documents switch
  in the selector and Remove from list drops one; a shell tab has no Docs button; a document in a tab behind shows
  when the tab comes to the front.

## README

The MCP paragraph and the Changes/Media sections mention `show_document` and the Docs panel. No new screenshot in
this change.
