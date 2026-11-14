# File paths in Claude's chat answers are links — design

## Why

Claude names files all the time: `.superpowers/sdd/2026-11-12-hub-fade-material-swap-design.md`, `src/main/index.ts:120`,
`D:\Work\notes.md`. In the chat they are plain text today (only http(s) addresses are links), so the person copies a path and
opens it by hand. They should open with a click.

## Goals

- In Claude's answers in the chat, a path to a file that exists is a link: in plain text, in an inline code span, and as the
  target of a Markdown link (`[spec](docs/spec.md)`).
- Relative paths are resolved against the tab's folder; absolute paths (Windows and POSIX) are taken as they are; a `:line`
  (and `:line:col`) suffix is kept for the editor.
- A click on a document (a kind the Docs panel shows: Markdown and the other `show_document` kinds) opens it in the Docs panel,
  as `show_document` does; a click on any other file opens it in the editor from Settings at its line, as the Changes panel's
  "Open in editor" does; with no editor set, the file is shown in its folder and never run.
- A path to a file that does not exist stays text.

## Non-goals

- The terminal view (the person chose the chat only).
- The person's own messages, tool call rows and tool output.
- Folders as links.
- Links on a remote tab (another device's files).

## Approaches

1. **Detect in the window, confirm in main (chosen).** The chat's Markdown renderer marks path-shaped text; the window asks main,
   once per message, which of them are files in the tab's folder; only those become links. Main checks again on click.
2. Detect and resolve everything in main as the transcript is folded. Rejected: the chat's Markdown is rendered in the window,
   and main would have to parse Markdown too.

## Design

- **Shape of a path** (window, a pure function with unit tests): a token with a `/` or `\` or starting with `./`, `../`, `~/`, or
  a drive letter, whose last part has a file extension, optionally followed by `:line` or `:line:col`; surrounding punctuation
  (`.,;:)]` and quotes) is not part of it. URLs are not paths.
- **Rendering.** `chatMarkdownHtml` wraps each path-shaped token of Claude's text items (text and inline code; Markdown link
  targets that are not web links) in a pending element carrying the path; it is not a link yet.
- **Confirming.** After a text item is drawn (and when it finishes streaming), the chat view sends its pending paths to main:
  new IPC `chatFileLinks(tabId, paths: string[]) → { path, file, kind: 'doc' | 'file', line }[]` (at most 200 per call). Main
  resolves each against the tab's folder (pathKey comparisons, short names, `~`), keeps those that are regular files, and says
  whether the Docs panel shows that kind (`docKindOf`). The window turns those into links (`chat-file-link`), the rest stay text.
- **Clicking.** A click sends `chatOpenFile(tabId, file, line)`; main checks again that it is a file and opens it: a doc through
  `DocHub.show` (the Docs panel opens on it), any other file through `launchEditor(settings.review.editor, file, line, …)`, which
  shows it in its folder when no editor is set.
- Main checks every IPC argument (`ipc-guards.ts`): a local Claude tab, an array of strings within a length cap, a line number.

## Tests

- Unit: the path shape (dot folders, relative, `./`, Windows and POSIX absolute, `:line`, `:line:col`, trailing punctuation, in
  backticks, URLs not paths, a word with a dot not a path).
- Unit or integration: main's resolution against a temp folder (relative, absolute, missing, a folder, `/` and `\`, case on
  Windows).
- End-to-end: an answer naming `.superpowers/sdd/plan.md`, `src/a.ts:12` and `missing/file.md` in a temp project: the first two
  are links, the third is text; clicking the first opens the Docs panel on it; clicking the second runs the editor command set in
  Settings with the file and line (a stand-in editor that writes what it got to a file).

## Left to the builder

The exact regex, the pending element's markup, when exactly the view asks (debounced while streaming).
