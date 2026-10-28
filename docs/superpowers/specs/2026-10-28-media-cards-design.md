# Audio and video cards in the image panel

## Intent

Claude sometimes makes or shows an audio or video file (a recording, a render, an `ffmpeg` result). Today the image
panel only knows images, so such a file never shows up and the user has to dig it out of the terminal. The user wants
to *see* that the file exists and *open it quickly*. They do not want a player in ClaudeTerm: the system player does
that better.

## Goals

- An audio or video file appears in the Claude tab's image panel as a card, in the same list and the same time order
  as images.
- One click opens the file in the system's default app. "Show in Explorer" is in the card's context menu.
- Files arrive by the same two routes as images, and no other: Claude shows one with `show_image`, or the file is
  created in the session's temp folder (scratchpad).

## Non-goals

- No playback, no preview, no thumbnail, no waveform, no duration (it would need a media parser).
- No watching of the project folder (the image panel's standing rule: its sources are the conversation, `show_image`
  and the scratchpad).
- No new setting. Media extensions are fixed in code.

## Anti-goals

- A media file must never be served through `ctimg://` or loaded into the renderer: the panel only shows its name and
  size.
- The panel's existing image behavior (lightbox, copy, thumbnails, the unseen counter) must not change.

## What the user sees

- A media card has a type icon (audio or video) instead of a thumbnail, the file name, the same source label
  (`created` / `show_image`) and the same caption as an image card.
- A click opens the file in the system app (images open the lightbox; media has none). The existing context menu
  already has "Open in viewer" and "Show in Explorer" and keeps them; copy-image does not apply to media cards.
- A file that is deleted afterwards is marked deleted, like an image.

## How it works (the parts the user decided)

- Sources: the scratchpad watcher also reports media files; `show_image` also accepts them.

## Calls made by the author (not asked of the user)

- **One tool.** `show_image` accepts audio and video too (same arguments), rather than a second tool; its description
  says so, so Claude knows. The pipe message stays `show_image`.
- **Formats.** Video: `mp4`, `mov`, `webm`, `mkv`. Audio: `mp3`, `wav`, `m4a`, `ogg`. Fixed list in
  `src/shared/image-file.ts` next to the image one; the user's `imageWatch.extensions` keeps meaning images only.
- **A card has a `kind`** (`image` | `audio` | `video`) derived from the extension, so the renderer and the main
  process agree on what a card is.
- **No size or duration on the card** (media is often still being written when first seen, so a size would be wrong).
  The card shows kind icon, name, source and caption.
- **Limits.** The 50 MB cap protects loading an image; media is never loaded, so it has no cap (a missing file, a
  directory or an unknown extension are still refused).
- **Same list and rules as images.** Media cards share the `maxItems` cap, the unseen counter, the "updated" mark and
  the deleted mark; the watcher's settling of half-written files applies to them as it does to images.
- **Image-only routes stay image-only.** The transcript (`read`, `tool`) and paste never produce media cards.
- **Extensions.** Matching is case-insensitive. The scratchpad watcher stays switched by `imageWatch.enabled`; media
  follows that switch. `show_image` accepts a file if it is an image (as today) or in the fixed media list.
- **Open re-checks.** Main re-validates the card's file (exists, is a file, extension still in the image or media
  list) before `shell.openPath`, and shows the OS error string as a toast if it returns one.
- **The tool's argument names and schema stay unchanged**; only its description changes.
- **Open uses the existing `imagesAction`** (`open`, `reveal`) in `src/main/index.ts`; `copy-image` on a media card is
  ignored. There is no keyboard selection of cards today; none is added.
- **Tests** as `AGENTS.md` asks: unit for the extension → kind mapping and the card; integration for the watcher
  reporting a media file in a temp folder and the pipe accepting `show_image` with an mp4; the `show_image` tool
  handler; e2e for the card showing without an `<img>` and a click asking main to open it (a stand-in for
  `shell.openPath` so no real player starts).

## Left to the builder

Card layout and icons (match the panel's current style), how the watcher's filter takes the extra extensions, the
exact test stand-ins.
