# Audio and video cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audio and video files created in a Claude tab's scratchpad, or shown with `show_image`, appear in the image panel as cards that open in the system player on click.

**Architecture:** `ImageCard` gets a `kind` (`image` | `audio` | `video`) derived from the file extension. The scratchpad watcher and `show_image` accept a fixed list of media extensions on top of the image ones. Media is never served through `ctimg://`; the renderer draws a type icon instead of an `<img>`, and a click sends the existing `open` image action, which main re-validates before `shell.openPath`.

**Tech Stack:** TypeScript (strict), Electron 44, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-media-cards-design.md`

## Global Constraints

- Media extensions, fixed in code, matched case-insensitively: video `mp4`, `mov`, `webm`, `mkv`; audio `mp3`, `wav`, `m4a`, `ogg`.
- `imageWatch.extensions` keeps meaning images only; no new setting.
- Media sources are only the scratchpad watcher (`created`) and `show_image` (`shown`); the transcript (`read`, `tool`) and paste never make media cards.
- No size or duration on the card. The 50 MB cap applies to images only.
- The `show_image` tool's argument names and schema do not change; only its description does.
- Media is never loaded into the renderer or served via `ctimg://`.
- Do NOT create git commits (the user commits themselves); leave the work uncommitted. Do not commit generated files.
- Comments, logs and UI strings are English; match the surrounding code's naming and comment density; keep each file's line endings.
- Verify with `npm run typecheck`, `npm test`, and for the e2e task `npm run build` first, then `npx playwright test tests/e2e/images.spec.ts`.

## Review Focus

- `Clip.MP4` (upper case extension) is a video: `mediaKindOf` test in Task 1.
- A directory named `x.mp4`, or a missing file, is refused by `show_image`: `checkShowableFile` tests in Task 1.
- A card's file deleted or replaced by a non-media file before the click: nothing is opened and the user gets a toast: `openCard` tests in Task 4.
- A media card is never served via `ctimg://`: `resolveImgRequest` test in Task 4.
- With a media card above an image card, clicking the image opens the lightbox on that image, not its neighbor: `lightboxTarget` test in Task 5.

---

### Task 1: Media kinds and the file check

**Files:**
- Modify: `src/shared/types.ts` (add `CardKind`, add `kind` to `ImageCard`)
- Modify: `src/shared/image-file.ts`
- Test: `tests/unit/image-file.test.ts`

**Interfaces:**
- Produces:
  - `export type CardKind = 'image' | 'audio' | 'video'` in `src/shared/types.ts`; `ImageCard.kind: CardKind`.
  - `export const MEDIA_EXTENSIONS: readonly string[]` (the eight above) in `src/shared/image-file.ts`.
  - `export function mediaKindOf(path: string): 'audio' | 'video' | null`
  - `export async function checkShowableFile(path: string, imageExtensions: readonly string[]): Promise<ImageCheck>`: a media extension needs only an existing regular file (no size cap); any other path goes through `checkImageFile(path, imageExtensions)` unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/unit/image-file.test.ts`, in the style of its existing temp-file tests:
  - `mediaKindOf('C:\\a\\Clip.MP4')` is `'video'`, `'/a/song.wav'` is `'audio'`, `'/a/shot.png'` and `'/a/mp4'` are `null`.
  - `checkShowableFile` on a real `.mp4` file larger than `MAX_IMAGE_BYTES` is `ok` (use a sparse file via `truncate`); on a missing `.wav` it is not ok with `file not found: <path>`; on a directory named `x.mp4` it is not ok with `not a file: <path>`; on `notes.txt` it is not ok and mentions `not a supported image type`; on a `.png` it behaves as `checkImageFile`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/image-file.test.ts`; expect FAIL (names not exported).
- [ ] **Step 3: Implement** the signatures above. `mediaKindOf` shares the extension parsing with `hasImageExtension`. Adding `kind` to `ImageCard` breaks `ImageHub` and test fixtures at typecheck; that is fixed in Task 2.
- [ ] **Step 4: Run** the same test; expect PASS.

---

### Task 2: Cards carry their kind

**Files:**
- Modify: `src/main/image-hub.ts` (card creation in `add`)
- Modify: every test fixture that builds an `ImageCard` literal (find them with `npm run typecheck`): add `kind: 'image'`
- Test: `tests/unit/image-hub.test.ts`

**Interfaces:**
- Consumes: `mediaKindOf` from Task 1.
- Produces: `ImageHub.add(...)` returns and stores cards with `kind` set to `mediaKindOf(path) ?? 'image'`; a card seen again keeps its kind.

- [ ] **Step 1: Write the failing test** in `tests/unit/image-hub.test.ts`: adding `D:\\tmp\\clip.mov` then `D:\\tmp\\plot.png` to one tab gives cards with `kind` `'video'` and `'image'`; adding the `.mov` again with `source: 'shown'` keeps `kind: 'video'` and does not duplicate the card. Another test: with `maxItems` 2, a media card and two images share the one cap (the oldest card is dropped whatever its kind).
- [ ] **Step 2: Run** `npx vitest run tests/unit/image-hub.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** in `ImageHub.add`'s new-card branch; fix the fixtures until `npm run typecheck` is clean.
- [ ] **Step 4: Run** `npm run typecheck` and `npx vitest run tests/unit/image-hub.test.ts`; expect PASS.

---

### Task 3: Media arrives through the scratchpad and `show_image`

**Files:**
- Modify: `src/main/index.ts` (`watchTemp`, around line 239; the `showImage` pipe handler, around line 528)
- Modify: `src/mcp/show-image-tool.ts`, `src/mcp/show-image-server.ts` (description only)
- Test: `tests/unit/show-image-tool.test.ts`; `tests/integration/image-watcher.int.test.ts`; `tests/e2e/images.spec.ts`

**Interfaces:**
- Consumes: `MEDIA_EXTENSIONS`, `checkShowableFile` (Task 1).
- Produces: `watchTemp` passes `{ ...settings.imageWatch, extensions: [...settings.imageWatch.extensions, ...MEDIA_EXTENSIONS] }` to `watchImages`; the `showImage` pipe handler and `handleShowImage` use `checkShowableFile(path, [...DEFAULT_IMAGE_EXTENSIONS, ...settings.imageWatch.extensions])` (the tool: `DEFAULT_IMAGE_EXTENSIONS`). The `show_image` description names audio and video: "Show an image, audio or video file to the user in the ClaudeTerm panel. Use after creating or finding a file the user should see or open." The `caption` description says "under the file".

- [ ] **Step 1: Write the failing tests:**
  - `show-image-tool.test.ts`: `handleShowImage({ path: 'talk.mp4' })` with a real temp `.mp4` sends `{ type: 'show_image', path: <abs>, ... }` and returns `Shown in ClaudeTerm: <abs>`; a missing `.mp3` returns `isError: true`.
  - `image-watcher.int.test.ts`: with `cfg.extensions` `['png', 'mp4', 'wav']`, a new `rec.wav` reports `add:`, and a `notes.txt` does not.
  - `images.spec.ts`: (a) `show_image` over the pipe with a real `.mp4` in the tab's work folder gives `images(page)` equal to `[{ name: 'clip.mp4', source: 'shown', caption: 'Render' }]`; (b) a `.wav` written into the session scratchpad (reuse the setup of the first test in that file, factor it into a helper in the file if it avoids copying) gives `[{ name: 'rec.wav', source: 'created', caption: null }]`; (c) a `.mp3` written into the project folder (not the scratchpad) never appears.
- [ ] **Step 2: Run** the unit and integration tests; expect FAIL. (The e2e needs Task 5's renderer only for DOM assertions; the `images(page)` assertions here work after this task. `npm run build` before `npx playwright test tests/e2e/images.spec.ts`.)
- [ ] **Step 3: Implement** the wiring and the description change.
- [ ] **Step 4: Run** `npm test`, then build and the e2e file; expect PASS.

---

### Task 4: Opening a media card, and never serving it

**Files:**
- Create: `src/main/image-open.ts`
- Modify: `src/main/index.ts` (`IPC.imagesAction` handler, around line 694)
- Test: `tests/unit/image-open.test.ts`; `tests/unit/img-protocol.test.ts`

**Interfaces:**
- Consumes: `checkShowableFile` (Task 1), `ImageCard`.
- Produces: `export async function openCard(card: ImageCard, deps: { imageExtensions: readonly string[]; openPath(path: string): Promise<string>; toast(message: string): void }): Promise<void>`: re-validates with `checkShowableFile(card.path, deps.imageExtensions)`; on failure calls `toast(check.error)` and does not open; otherwise calls `openPath(card.path)` and, when it resolves to a non-empty error string, `toast` that string. The `open` branch in `index.ts` calls `openCard` with `shell.openPath` and the existing `toast`; the `copy-image` branch does nothing when `card.kind !== 'image'`.

- [ ] **Step 1: Write the failing tests:**
  - `image-open.test.ts` (fake deps, real temp files): a media card whose file exists opens once with its path and no toast; the file deleted → no open, a toast containing `file not found`; the file replaced by a directory → no open, a toast; `openPath` resolving `'No application is associated'` → that text toasted; an image card (`.png`) opens too.
  - `img-protocol.test.ts`: `resolveImgRequest` for a hub card of kind video (a real `.mp4` file) with extensions `['png']` returns `null`, and also returns `null` when `extensions` includes `mp4`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/image-open.test.ts tests/unit/img-protocol.test.ts`; expect FAIL. (The second `img-protocol` case fails until `resolveImgRequest` refuses `card.kind !== 'image'`.)
- [ ] **Step 3: Implement** `openCard`, the `index.ts` branches, and the `kind` refusal in `resolveImgRequest`.
- [ ] **Step 4: Run** the same tests and `npm run typecheck`; expect PASS.

---

### Task 5: The media card in the panel

**Files:**
- Modify: `src/renderer/image-panel.ts`, `src/renderer/styles.css`
- Test: `tests/unit/image-panel.test.ts` (create); `tests/e2e/images.spec.ts`

**Interfaces:**
- Consumes: `ImageCard.kind` (Task 1), the `open` image action (Task 4).
- Produces: `export function lightboxTarget(cards: ImageCard[], index: number): { cards: ImageCard[]; index: number }`: the image cards only, and the index of `cards[index]` among them. `ImagePanelCallbacks.open` is called with that result. A media card renders `div.card-icon` (a 🎵 for audio, 🎬 for video, no `<img>`), its click calls `cb.action(card.id, 'open')`, and its context menu is the existing one without "Copy image" (its "Open in viewer" label stays).

- [ ] **Step 1: Write the failing tests:**
  - `image-panel.test.ts`: `lightboxTarget([video, imgA, audio, imgB], 3)` returns the two images and index `1`; `lightboxTarget([video, imgA], 0)` is not asked for media (document that by testing index of an image only).
  - `images.spec.ts`: stub `shell.openPath` and `showItemInFolder` in the main process the way `tests/e2e/review.spec.ts` does (`stubShell`); with a `.mp4` shown over the pipe and a `.png` shown after it, the panel has one `.card-icon` and one `img`, the media card has no `img`; clicking the media card records `open <path>`; right-clicking it lists `Open in viewer`, `Show in Explorer`, `Copy path`, `Insert path into terminal`, `Remove from panel` and not `Copy image`; clicking the image card still opens the lightbox.
- [ ] **Step 2: Run** `npx vitest run tests/unit/image-panel.test.ts`; expect FAIL; build and run the e2e; expect FAIL.
- [ ] **Step 3: Implement** in `image-panel.ts` and `styles.css` (match the `.card` style; the icon takes the thumbnail's place).
- [ ] **Step 4: Run** `npm run typecheck`, `npm test`, `npm run build`, then `npx playwright test tests/e2e/images.spec.ts tests/e2e/image-button.spec.ts`; expect all PASS.

---

## Self-Review

- Spec coverage: sources (Task 3), kind and shared list/cap/unseen rules (Task 2; unseen and `updated` come with `ImageHub.add` unchanged), click-to-open and menu (Tasks 4–5), re-validation and toast (Task 4), never served (Task 4), tool description and unchanged schema (Task 3), image-only transcript and paste routes (no change needed; media extensions are not in the transcript parser's list).
- Types: `CardKind`, `mediaKindOf`, `checkShowableFile`, `openCard`, `lightboxTarget` are named the same wherever used.
