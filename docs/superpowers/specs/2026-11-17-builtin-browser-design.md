# Built-in browser for Claude tabs: design

Date: 2026-11-17. Status: written for approval.

## Intent

The person wants a web browser inside ClaudeTerm that Claude can use and control from a Claude tab: open pages, read
them, click, type, take screenshots, read the console and the network. They want it for two kinds of work, equally:

- **Their own sites on localhost**: Claude opens the dev server, walks through a flow, and reads console errors, failed
  requests and screenshots to find and check fixes.
- **Sites where they are signed in** (admin panels, trackers, web apps): Claude works there in their name. For this they
  want to bring their sign-ins over from the browsers they already use in one click, picking the Chrome profile (or other
  browser and profile) to take them from, and they want protection against actions Claude should not take in their name.

The project note lists it as an open item ("Встроенный браузер, возможность чтобы клод юзал браузер из приложения").
The original request (Russian): "Встроенный браузер, возможность чтобы клод юзал браузер из приложения, в том числе чтобы
мог управлять там всяким. Желательно еще функционал чтобы куки переносить из нужных браузеров в один клик (в т.ч разные
профили хрома)".

### Decisions the person made (2026-11-17)

- Both scenarios count equally (localhost work and signed-in sites).
- The browser lives in the **right-hand side panel**, as a new panel tab next to Media, Changes and Docs.
- **One plan for everything**: the browser with Claude's control and the cookie import are planned and built together.
- **Per-site permission**: on local pages Claude works freely; any other site needs the person's yes in the panel, for
  this tab or always.
- **Several browser profiles** in ClaudeTerm, each with its own sign-ins; each Claude tab uses one.
- They approved the playback of profiles and protection (the "Profiles" and "Protection" sections below, as played back).
- **Import from Chrome, Edge and Brave on Windows: from the running browser** (changed 2026-11-18, after the check on a
  copy of the person's real profiles showed that a copy cannot decrypt App-Bound `v20` cookies). The person turns on the
  browser's remote debugging once; ClaudeTerm opens that setting page in the browser itself, connects, the browser asks
  "Allow?", and ClaudeTerm reads the cookies of a profile open in it. The browser stays open.
- **Page dialogs are answered automatically** (2026-11-18): `alert` is closed, `confirm` answers Cancel, `prompt` answers
  nothing; Claude can set the answer for the next dialog beforehand; the page footer reports each one.
- **The browser's cookie store is encrypted on disk** (Electron's `EnableCookieEncryption` fuse), as Chrome does.
- **A site card is answered only in this window.** No answering from a paired device or through Remote Control (v1).

## Goals

- A **Browser** panel tab in the right-hand side panel of every local Claude tab (terminal or chat view). Each Claude tab
  has its own browser: its own pages, its own history. Two Claude tabs never drive the same page.
- Claude controls its tab's browser through new tools of the bundled `claudeterm` MCP server.
- The person sees what Claude does, can use the same pages themselves (address field, back, forward, reload, page strip),
  and can stop Claude at any time.
- Browser **profiles**: "Default" always exists; the person adds more ("Work", "Personal"). Each profile has its own
  cookies, storage, history and list of always-allowed sites.
- **Per-site permission** for everything Claude does outside local pages.
- **Cookie import** from Chrome, Edge, Brave, Vivaldi, Chromium and Firefox on Windows, macOS and Linux, from a chosen
  browser profile into a chosen ClaudeTerm profile.
- The pages of each Claude tab and its profile come back after a restart, as tabs do.

## Non-goals

- Tabs of a paired device shown in this window: no Browser panel (v1). Shell tabs: no Browser panel (v1).
- Exposing a CDP / remote-debugging port, or letting an outside MCP (Playwright MCP, chrome-devtools-mcp) attach.
- Claude importing cookies. Import is only ever the person's action; there is no tool for it.
- Reading the cookies of a Chrome/Edge/Brave profile that is not open in the running browser on Windows (only profiles
  with an open window can be read there; see Approaches).
- Turning the person's browser's remote debugging on or off for them: ClaudeTerm only opens the page; the person flips it.
- Carrying over Google sign-ins from Chrome on Windows: Chrome binds them to the device (Device Bound Session
  Credentials, default since May 2026), so copied Google cookies stop working. The import says so.
- Firefox containers: only the default container's cookies are imported (`originAttributes` empty).
- Passwords, history, bookmarks, extensions, autofill: not imported. Nor is site storage (localStorage, sessionStorage,
  IndexedDB): sites that keep their sign-in there (Firebase, Supabase, Auth0-style apps) need a fresh sign-in in the
  panel. The import is named "Import cookies…" and its result says so.
- Answering a site card from a paired device or through Remote Control.
- Cross-origin iframes in Claude's page snapshot and clicks (Stripe-style embedded forms): v1 covers the main frame and
  same-origin frames. Claude still sees cross-origin iframes in screenshots.
- File uploads, drag and drop, camera/microphone/geolocation/notification permissions for pages (all denied in v1).
- Browser extensions, a password manager, print, PDF export.
- A pop-out browser window, or a browser as its own tab in the tab bar.

## Anti-goals (a failure even if it works)

- **Any local process, or a web page, gets control of ClaudeTerm through the browser feature.** No debug port, no
  renderer privileges for pages, nothing a page can call.
- **Cookies leak**: into logs, error messages, test fixtures, crash reports, Claude's context (Claude never gets a cookie
  list), or temp copies left behind.
- **Claude acts on a site the person did not allow** — including after a redirect, a click that leaves the site, or a page
  the person opened themselves.
- **The person's own browser profile is changed.** Import only ever reads (a copy, or the running browser over the
  connection the person allowed); ClaudeTerm writes nothing to the source browser's folder, never closes, navigates or
  changes the person's tabs, and never sends `Browser.close` to a browser it did not start.
- **The main process blocks** on CDP, an import or a page: the pipe and the window stay responsive.

## Constraints (from the project)

- Electron 44.5 (Chromium 152, Node 24.21). `node:sqlite` (`DatabaseSync`) works in Electron's Node without flags
  (checked: SQLite 3.53.4) — no new dependency for reading cookie databases. No new runtime dependency is needed at all.
- The renderer stays sandboxed; pages run in `WebContentsView`s with their own session partition, never with the app's
  preload, never in the app's session. Main checks every IPC argument (`ipc-guards.ts`).
- Everything from the pipe and from pages is untrusted. Any process of the user can write to the pipe; a page's text is
  untrusted input to Claude (prompt injection).
- The pipe protocol: one JSON line per request, at most 64 KiB (`MAX_LINE`); the response has no size limit. The MCP
  server runs as `ELECTRON_RUN_AS_NODE` and reaches main only through the pipe, identifying its tab by
  `CLAUDETERM_TAB_ID`.
- UI-visible strings are English (AGENTS.md). The mockups in the conversation were in Russian for the discussion only.
- Tests never touch the machine: no real browser profile is read, no real browser is started by the default test run;
  everything is built under `tmpdir()`. No real cookies anywhere in the repository.
- CI must be green on Windows, macOS and Linux, including e2e.

## Approaches

### How Claude drives the browser (one sensible way)

**Chosen: tools in the bundled `claudeterm` MCP server → pipe → main → `webContents.debugger` (CDP) on the tab's page.**
Main owns the pages and runs every command; the MCP server only validates input and formats results.

Rejected:
- *A remote-debugging port for an existing browser MCP (Playwright MCP, chrome-devtools-mcp).* Electron's
  `--remote-debugging-port` is app-wide: it would expose ClaudeTerm's own window, whose preload bridge can type into
  terminals — any local process could run commands through it. It also has no notion of which Claude tab may drive which
  page, and no place for per-site permission.
- *Claude Code's own Chrome integration (`/chrome`, the Claude in Chrome extension).* It drives the person's external
  Chrome, not a browser in ClaudeTerm; it stays available to the person as it is.

### How a page is shown (one sensible way)

**Chosen: a `WebContentsView` per page, added to the main window's `contentView` and laid over the Browser panel's body.**
An `<iframe>` cannot show most sites (X-Frame-Options / frame-ancestors); `<webview>` is discouraged and would run inside
the app's renderer. Consequence: a native view is drawn over all HTML, so while a ClaudeTerm menu, popover, dialog or the
lightbox overlaps the panel, the page is hidden (the panel shows a still image of the page meanwhile).

**Pages not on screen keep working by being "parked" (checked 2026-11-18).** A view that is removed, hidden with
`setVisible(false)` or moved fully outside the window stops taking CDP clicks and screenshots, and a `BrowserWindow`'s
own UI cannot be put above a child view. A page that is not shown therefore stays added and visible at its page size,
placed so that one pixel of it lies inside the window's bottom-right corner, under a 1×1 opaque `View` in the window's
background colour. Probe on Electron 44.5.1, 3 runs: 60 of 60 park/unpark cycles with working CDP clicks and fresh
screenshots; a page created parked works (its first screenshot takes about 4 s); a window covered by another window
works; while the window is minimized clicks work but screenshots do not, so a screenshot then tells Claude to ask the
person to restore the window.

### Cookie import from Chromium browsers (the person chose for Windows)

The facts (checked 2026-11-17): on Windows, Chrome (since 127), Edge and Brave encrypt cookies with App-Bound Encryption
(`v20`): only the browser itself, through its elevation service, can decrypt them; since Chrome 114 the cookie database is
locked exclusively while the browser runs, so it cannot even be copied; since Chrome 136 remote debugging is refused on
the default user-data folder but allowed on any other.

Options shown to the person:
1. **Close the browser; ClaudeTerm copies the profile, starts the real browser on the copy without a window, reads the
   cookies over CDP, ends it and deletes the copy.** Works for Chrome, Edge and Brave with no setting in the browser.
   Needs the browser closed for a few seconds on Windows. **Chosen.**
2. Connect to the running Chrome after the person enables `chrome://inspect#remote-debugging` (Chrome 144+); Chrome asks
   "Allow?" each time. Browser stays open; unknown for Edge and Brave, and unclear which profile is read when several are
   open.
3. Both, preferring 2 when it is enabled. Twice the work and checks.

Rejected without offering: injecting into the browser's process or calling its elevation service from ClaudeTerm (how
forensic tools and malware do it; antivirus flags it, it breaks with each Chrome release); asking for admin rights.

**My call (builder: verify in the spike):** the same "run the real browser on a copy" method is used for Chromium browsers
on macOS and Linux too, where the copy can be made while the browser runs. The browser then unlocks its own key (macOS
Keychain, Linux libsecret/KWallet) as it always does, so ClaudeTerm needs no cookie cryptography at all and the person sees
no Keychain prompt from ClaudeTerm. If the spike shows this fails on macOS or Linux, fall back there to reading the
database directly and decrypting it (macOS: Keychain item "<Browser> Safe Storage" through `security`, PBKDF2-SHA1 with
salt "saltysalt", 1003 iterations, AES-128-CBC, `v10`; Linux: `v10` with the fixed key "peanuts", `v11` with the key from
libsecret), which shows a one-time Keychain prompt on macOS. The design otherwise does not change.

**Firefox** (one way): `cookies.sqlite` is plain; copy it with its `-wal`/`-shm` files to a temp folder, read it with
`node:sqlite`, delete the copy. Works while Firefox runs.

**Spike first.** The first task of the plan proves, on a real Chrome on Windows with a throwaway profile made for the
spike (never the person's profile), that a copied profile run with `--user-data-dir=<copy>` and `--remote-debugging-pipe`
returns decrypted `v20` cookies through `Storage.getCookies`, and finds which files the copy needs (at least `Local State`
and the profile's `Network/Cookies` with its journal/WAL). Also on macOS and Linux if a machine is at hand. If it fails on
Windows, stop and report to the person before building the import: there is then no honest way to import from those
browsers on Windows without option 2, and the person decides.

**Result and the person's decision (2026-11-18).** With the person's yes, the check ran on copies of two of their real
Chrome 157 profiles (printing counts only; copies deleted): 1 269 and 927 `v20` rows, 216 and 799 of them unexpired, and
Chrome on the copy returned **0** cookies — App-Bound Encryption works only in the browser's own default folder, and
Chrome 136+ refuses remote debugging there. Copying cannot import `v20` cookies on Windows. The person chose option 2,
and it was checked on their running Chrome with their yes (counts only): after they turned on remote debugging at
`chrome://inspect/#remote-debugging`, a WebSocket connection to the port named in `<User Data>/DevToolsActivePort` read
3 494 cookies (3 475 with values) of one open profile and 800 of a second open profile. Facts found:

- Each open profile is its own browser context on the page targets (`Target.getTargets` → `browserContextId`), but
  `Storage.getCookies {browserContextId}` refuses those ids, and `Storage.getCookies` without one returns the profile
  whose window was active last. **Per profile**: attach to one page target of that context (`Target.attachToTarget`,
  `flatten: true`), send `Network.getAllCookies` on that session, detach.
- A profile without an open window cannot be read; the person opens a window of it first.
- `chrome.exe chrome://inspect/#remote-debugging` opens that page in the running Chrome (or starts Chrome on it), so
  ClaudeTerm can take the person there itself (the person asked for this).
- Edge and Brave are Chromium browsers with the same page (`edge://inspect/#remote-debugging`,
  `brave://inspect/#remote-debugging`); not checked on a real machine — if no connection appears, the sheet says the
  browser does not offer it.

So on Windows, Chrome, Edge and Brave are read **live**; Vivaldi and Chromium (no App-Bound Encryption) and every
Chromium browser on macOS and Linux keep the copy method; Firefox is unchanged.

## What the person sees

UI text below is the real English text (suggested; the builder may polish wording, not meaning).

### The Browser panel

A new panel tab **Browser** in the right-hand side panel, available while a local Claude tab is in front. Shortcut
`Ctrl+Shift+B` / `⌘B` (builder: confirm it is free on all three systems, otherwise pick a free one), also in the panel
switcher like the others. It keeps its own width like the other panel tabs and can be expanded over the terminal.

```
┌─ Browser ──────────────────────────────── ⤢  ✕ ┐
│ [Work ▾]  [localhost:5173 ×] [Issues ×]  [+]    │   profile, page strip, new page
│ ← → ⟳  http://localhost:5173/login        ⋯    │   nav, address field, menu
│ ┌─────────────────────────────────────────────┐ │
│ │                                             │ │
│ │              (the page)                     │ │
│ │                                             │ │
│ └─────────────────────────────────────────────┘ │
│ ◉ Claude is using the browser          [Stop]   │   control line
└─────────────────────────────────────────────────┘
```

- **Profile selector**: the tab's profile. Choosing another one closes this tab's pages and opens the same URLs again in
  the new profile (sign-ins differ). "Manage profiles…" at the bottom opens Settings › Browser.
- **Page strip**: this tab's pages (Claude may open several; the person too). Click to show, × to close, + for a new
  blank page. Pages opened by `window.open`/`target=_blank` join the strip (keeping `window.opener`, so sign-in popups
  work).
- **Navigation row**: back, forward, reload/stop, the address field (the person types a URL or a search-free address;
  `http(s)://` and `file://` only; text without a scheme gets `https://`, or `http://` for localhost), a menu with
  "Open DevTools" (if DevTools can coexist with Claude's debugger, else left out — builder checks) and "Clear this
  profile's data…".
- **Control line** at the bottom:
  - nothing while Claude has not used this tab's browser yet, or is idle;
  - "Claude is using the browser · Stop" while a command runs or ran in the last few seconds;
  - after Stop: "You have control · Hand back to Claude". Until handed back, every browser command of this tab returns
    an error to Claude: "The person took control of the browser. Ask them before using it again."
- **Permission card** (see Protection) appears above the control line.
- Empty state (no page yet): a short line "Claude can open pages here, or type an address above."
- When Claude's first navigation in a tab happens while that tab is in front and the panel is closed, the panel opens on
  Browser (once per tab; not again after the person closes it). In a tab not in front, nothing pops up.

While a ClaudeTerm overlay (menu, popover, dialog, lightbox, settings sheet) overlaps the panel, the page's view hides and
a still image of it shows in its place, so the overlay is visible.

### Protection (approved playback)

- **Local pages are free**: `localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, and `file://`. Claude works there without
  asking.
- **Any other site needs the person's yes** for everything Claude does there: open it, read it (snapshot, screenshot,
  text, console, network), click, type, run JavaScript. A **site** is the host without a leading `www.`; allowing a site
  allows its subdomains. (Builder's call how to treat public suffixes; at minimum `co.uk`-style hosts must not become
  "sites" that cover everything under them — use the host the person sees, never shorter than two labels.)
- The card in the panel:

  ```
  ┌──────────────────────────────────────────────┐
  │ Claude wants to open github.com              │
  │ [Allow in this tab] [Always allow] [Deny]    │
  └──────────────────────────────────────────────┘
  ```

  "Wants to open" for a navigation, "wants to use" for an action on a page already open on that site.
  - **Allow in this tab**: until the Claude tab is closed (not kept across restarts).
  - **Always allow**: saved in the tab's profile; listed and removable in Settings › Browser.
  - **Deny**: Claude's command returns "The person did not allow <site>."
- While the card waits, the tab asks for attention as a Claude Code permission prompt does (the `permission`
  notification case: tab mark, sound, flash, banner per the person's settings), and the panel switches to Browser if this
  tab is in front. No answer in **10 minutes**: the command returns "The person did not answer about <site>." and the card
  goes away.
- The person's own navigation is never asked about. But Claude can read or act on a page only if its current site is
  allowed: a page the person opened leads to the card on Claude's next command there.
- **Navigations Claude causes are held** (my call, after the builder check): a top-level navigation to a site that is not
  local or allowed which starts while a Claude command runs — a link Claude clicked, a redirect, a script setting
  `location`, a form submit, `window.open` — is stopped before it leaves (`will-navigate`, `will-redirect`, the window
  open handler) and the card asks "Claude wants to open <site>". Allow: the navigation is made again to that URL (a GET;
  a held POST is not repeated, and Claude is told to submit again). Deny: it stays cancelled and the command returns
  "The person did not allow <site>." So Claude reaches a new site only after the person's yes.
- The card is shown and signalled **only in this window, on this device** (the person's decision): its attention is not
  forwarded to paired devices, since they could not answer it. A command that ends without an answer tells Claude to let
  the person know it waits for the Browser panel.
- **Stop** ends the running command (it returns "Stopped by the person.") and takes control as described above.
- Claude never sees a cookie list and has no import tool. Claude's page list shows only the host for a page on a site that
  is not allowed (no title, no path).
- Residual risk, stated in the docs: a page Claude may use — a local page or an allowed site — is trusted fully. Script
  Claude runs there (or the page's own script) can still send background requests (`fetch`, images, forms in frames) to
  other sites, and such requests carry the profile's cookies as any browser would send them (SameSite rules apply); only
  top-level navigations are held. Claude Code's own deny rules for the `browser_*` tools still apply.
- **ClaudeTerm pre-allows the `browser_*` tools in Claude Code's permissions** (my call, after the builder check), as it
  already does for its task-list, agent and coordinator tools (`claude-tab-settings.ts`): the site gate is the protection
  the person chose, and a second Claude Code prompt per tool would contradict "on local pages Claude works freely". The
  person's own deny rules still win.

### Profiles (approved playback)

- "Default" always exists and cannot be deleted. The person adds, renames and deletes others in **Settings › Browser**
  (a new settings tab), and picks the **default profile** for new Claude tabs.
- Each profile is its own persistent Electron session partition: its cookies, local storage, cache, history and list of
  always-allowed sites.
- A Claude tab's profile is chosen in the panel's profile selector; the tab keeps it, and it is restored after a restart.
  A fork starts with no pages, on its parent's profile. Deleting a profile moves its tabs to "Default" and deletes the
  profile's stored data.
- Settings › Browser per profile: name, "Import cookies…", "Always allowed sites" (list, remove), "Clear data…",
  "Delete". Plus the default profile choice.

### Always allow all sites (added 2026-11-19, after the person tried the local build)

The person asked for "a checkbox to always allow visiting any site". It is a flag of each profile, chosen over a `*` in
the always-allowed list (that would mix a site with "everything") and over one switch for the whole app (that would also
open the profile that holds the bank's cookies).

- **Where it lives.** Each profile's card in Settings › Browser has the switch **Always allow all sites**. It is off by
  default and kept in the profile store; an older store file loads it as off.
- **The warning.** A line always shows under the switch: "Claude opens any website in this profile without asking,
  signed in with its cookies." There is no confirm dialog, by the person's choice.
- **What it allows.** While the switch is on, the site gate allows every http and https site for every tab on that
  profile. That covers opening a site, reading it and acting on it, held navigations (links, redirects, scripts, forms,
  `window.open`), Claude's back and forward, and pages the person opened. No card shows, and replies to Claude no longer
  mask those pages.
- **What it does not change.**
  - Local files keep the tab-folder rule: a file outside the tab's folder still asks with its own card.
  - Local http pages stay free, as before.
  - Other URL schemes are still refused.
  - A held form POST is still not sent again.
- **The always-allowed list stays.** While the switch is on, the list is shown dimmed but can still be edited, and it
  applies again once the switch is off.
- **A card already waiting** when the switch is turned on stays until the person answers it (builder's call).
- **Residual risk.** The README says it plainly: with the switch on, Claude can visit and act on any site the profile
  is signed in to.

### Cookie import

From Settings › Browser › a profile › **Import cookies…** (and from the panel's profile menu). A sheet:

```
┌─ Import cookies into "Work" ─────────────────────────┐
│ From: [ Chrome · Work (name@example.com)        ▾ ]  │
│                                                      │
│ ⚠ Close Chrome to continue. The import starts as     │
│   soon as it is closed.                    [Cancel]  │
│                                                      │
│ ✔ Imported 1,240 cookies for 312 sites.              │
│   Google sign-ins are not carried over: Chrome ties  │
│   them to this computer.                             │
└──────────────────────────────────────────────────────┘
```

- **Sources found automatically** on this system, each with its profiles: Chrome (Stable; builder may add Beta/Canary),
  Edge, Brave, Vivaldi, Chromium, Firefox. For Chromium browsers the list shows each profile's name and email from
  `Local State` (`profile.info_cache`: `name`, `user_name`); for Firefox the profile names from `profiles.ini`.
  A browser that is not installed is not listed; a profile folder without cookies is listed greyed out.
- **One click**: choose the source, press Import. The cookies are added to the ClaudeTerm profile; a cookie with the same
  domain, name and path is replaced, all others stay. Expired cookies are skipped; partitioned (CHIPS) cookies are skipped
  if Electron cannot set them, and counted.
- **Windows, Chrome / Edge / Brave (live)** — the list shows one entry per installed browser, "Chrome · open profiles".
  On Import:
  1. If ClaudeTerm cannot connect (no `DevToolsActivePort`, or the port refuses), it **opens
     `chrome://inspect/#remote-debugging` in that browser itself** and the sheet says: "Chrome opened its remote
     debugging page. Turn on remote debugging there; the import goes on by itself." It retries every second (Cancel
     stops).
  2. Connected: "Allow the connection in Chrome." until the browser's own prompt is answered.
  3. One open profile → it is imported. Several → the sheet lists them, each by its open tabs ("12 tabs: GitHub, Gmail,
     Jira"), and the person picks one; a hint says "To import another profile, open a window of it in Chrome."
  4. ClaudeTerm closes its connection; Chrome stays open. The result adds "You can turn remote debugging off again on
     the same page."
- **Windows, Vivaldi / Chromium (copy)**: if the browser holds its cookie file, the sheet says "Close <Browser> to
  continue" and retries every second; it adds "If it keeps running in the background, quit it from the tray icon."
  Cancel stops waiting. The import never closes the browser itself.
- **Result**: "Imported N cookies for M sites." plus "Sites that keep their sign-in outside cookies need you to sign in
  again here." On Windows from Chrome/Edge/Brave, the Google note above. Errors in plain
  words: "Chrome is not installed where ClaudeTerm looks for it", "Could not read the cookies: <reason>". No cookie name
  or value ever appears in a message or a log.
- Imported sign-ins must survive a ClaudeTerm restart, including cookies that had no expiry in the source (builder: check
  whether Electron's persistent partition keeps session cookies; if not, give such cookies a far expiry).

## Claude's tools

New tools in the bundled `claudeterm` MCP server (`src/mcp`). Names and shapes follow Playwright MCP, which Claude already
knows. All work only in a ClaudeTerm Claude tab (otherwise: "The browser works only in a ClaudeTerm Claude tab").

| Tool | Does |
|---|---|
| `browser_navigate {url}` | Open a URL in the current page (creating one if there is none) and wait for load |
| `browser_navigate_back`, `browser_navigate_forward`, `browser_reload` | As named |
| `browser_snapshot` | The page as an accessibility tree in text, each actionable element with a ref (`[ref=e12]`) |
| `browser_click {ref, element, button?, doubleClick?}` | Click the element (scrolled into view, at its centre) |
| `browser_type {ref, element, text, submit?, slowly?}` | Focus and type; `submit` presses Enter |
| `browser_press_key {key}` | A key or a combination |
| `browser_hover {ref, element}` | Hover |
| `browser_select_option {ref, element, values}` | Choose options in a `<select>` |
| `browser_scroll {ref?, direction, amount?}` | Scroll the page or an element |
| `browser_wait_for {text?, textGone?, time?}` | Wait for text to appear/disappear or for seconds (max 60 s) |
| `browser_take_screenshot {fullPage?, ref?}` | An image of the viewport, the full page or one element (returned as MCP image content) |
| `browser_evaluate {function, ref?}` | Run a JavaScript function in the page (or with the element) and return its JSON result |
| `browser_console_messages {onlyErrors?}` | Console messages and uncaught errors since the page loaded (kept: the last 500 per page) |
| `browser_network_requests {}` | Requests since the page loaded: method, URL, status, type, failure (last 500 per page) |
| `browser_network_request {id}` | One request's headers and response body (text, cut to a limit) |
| `browser_handle_dialog {accept, promptText?}` | Set the answer for the next `alert`/`confirm`/`prompt` (pages never show one; see below) |
| `browser_tabs {action: list/new/select/close, index?, url?}` | This Claude tab's pages |

- Every tool returns, after its own result, a short page state: the current URL and title, and new console errors or
  downloads since the last tool call. A snapshot result is cut to a size limit (builder picks it, ~60k characters) with
  a note how to narrow it.
- Refs are valid until the next snapshot or navigation; a stale ref returns "The page changed; take a new snapshot."
- Page dialogs never open (the person chose this on 2026-11-18, after the spike showed a native dialog box can stay on
  screen after CDP answers it): pages run with `disableDialogs`, and a script added to every document replaces `alert`,
  `confirm` and `prompt` — an alert is closed, a confirm answers Cancel, a prompt answers nothing, unless Claude set the
  next answer with `browser_handle_dialog` beforehand. The page footer reports each dialog:
  `- Dialog: confirm "Delete this item?" → Cancel`. This applies to the person's own clicks in the panel too.
- One command at a time per Claude tab (they queue in main). Every command has a time limit (navigation 60 s, others
  30 s) apart from waiting for the person's permission (10 min).
- The tool descriptions tell Claude about local-vs-allowed sites and that the person may be asked.

## How it works (for the builder)

### Pieces

- `src/mcp/browser-tools.ts`: registers the tools, validates input with zod, sends one pipe message per call, formats
  results (text and image content). Uses `sendPipeMessage` with a timeout longer than main's own limits (permission wait
  included).
- `src/shared/protocol.ts`: a `browser` pipe message `{v:1, type:'browser', tabId, op, args}` with a parser that validates
  `op` and each op's args (types, lengths; a request still fits in 64 KiB, so `evaluate` and `type` text are capped).
  Responses carry text, optional image (base64 + mime) and the page state.
- `src/main/browser/`: the browser hub in main:
  - **profiles store** (in ClaudeTerm's data folder): profiles `{id, name}`, the default, each profile's always-allowed
    sites. Partition name `persist:browser-<id>`.
  - **tab browsers**: per Claude tab, its pages (`WebContentsView` each), the current page, the profile; created lazily
    on first use or first show.
  - **page driver**: attaches `webContents.debugger` to each page; runs commands over CDP (`Accessibility.getFullAXTree`
    and `DOM.*` for snapshots and refs, `Input.*` for clicks and keys, `Page.captureScreenshot`, `Runtime.evaluate`,
    `Network.*`, `Log.*`/`Runtime.consoleAPICalled` into ring buffers, `Page.javascriptDialogOpening`).
  - **site gate**: decides local / allowed / ask for a URL and a tab; holds the waiting permission requests and the
    top-level navigations a Claude command started (see Protection); talks to the renderer for the card and to
    `Attention` for the signal, on this device only.
  - **layout**: places the views over the panel body by bounds the renderer reports (renderer → main IPC, checked), shows
    the current page of the tab in front only, hides views under overlays, keeps hidden pages working (see Risks).
  - **session restore**: per tab, the profile and the pages' URLs and current index, in the session snapshot; pages load
    lazily when shown or used.
- `src/main/browser-import/` (import): source discovery (paths per OS, `Local State`, `profiles.ini`), the Firefox reader,
  the Chromium "run on a copy" reader (copy → spawn the browser binary with `--user-data-dir=<copy>`
  `--profile-directory=<name>` `--remote-debugging-pipe` `--no-first-run` `--no-default-browser-check` and no window →
  `Storage.getCookies` over the pipe (fd 3/4) → end the process → delete the copy), the mapping to Electron cookie
  details, and the write into the target partition. Runs off the main thread's critical path (async, a time limit, the
  copy and the child process cleaned up on every path, also on cancel and on app quit).
- Renderer: `browser-panel.ts` (the panel body, strip, address row, control line, card, still image under overlays),
  `side-panel.ts` gets the `browser` panel tab, Settings gets a **Browser** tab.
- Pages: their own partition, no preload, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
  `backgroundThrottling: false` (Claude drives pages that are not visible); `setWindowOpenHandler` keeps new windows in
  the strip; `will-navigate` allows only `http(s)`, `file`, `about:blank`; other schemes (mailto:, custom app links) are
  refused; permission requests (camera, mic, geolocation, notifications, clipboard read, MIDI, HID…) denied; downloads go
  to the system Downloads folder without a dialog and are reported in the panel and to Claude.
- The app's own `win.webContents` navigation rules stay unchanged; the views are separate webContents.

### Security notes

- Same trust model as the rest of the pipe: a process of the same user that knows a Claude tab's id can send browser
  commands for it. That process could already read ClaudeTerm's cookie store on disk, so this adds no new access; still,
  the site gate applies to it as to Claude, and the person sees every command's effect in the panel.
- Main validates every op and argument; URLs are parsed with `URL`, schemes allow-listed; `evaluate` runs only in the
  page's main world; nothing a page does reaches main other than through Electron's normal webContents events.
- Cookies exist only in memory between reading and `cookies.set`; the temp copy lives in a private folder (created with
  owner-only permissions where the OS supports it) and is deleted in a `finally`, and at the next start if a crash left it.
- **The cookie store is encrypted on disk** (the person's decision): the packaged app turns on Electron's
  `EnableCookieEncryption` fuse (electron-builder's `electronFuses` option in `electron-builder.yml`), so every partition's
  cookie database is encrypted with the OS key as Chrome does (Windows DPAPI, the macOS Keychain item ClaudeTerm's
  `safeStorage` already uses, Linux libsecret/KWallet, or Chromium's fixed fallback key on Linux without a keyring). Facts
  the builder must keep in mind:
  - It is one-way: turning the fuse off later makes the stored cookies unreadable. Existing plain cookies (the app's own
    default session) are read as before and encrypted when written again.
  - It covers the whole app, not only the browser partitions; that is intended.
  - Only the packaged binary carries the fuse; dev and e2e runs use the stock Electron binary. The tests therefore prove
    the setting, not the encryption itself: a test that fails when `electron-builder.yml` does not turn the fuse on, and
    (builder: if practical on the CI runners) an integration test that flips the fuse on a copy of the Electron binary
    with `@electron/fuses`, runs it on a temp data folder, sets a cookie, and checks the value is not in the database file
    in plain text.
  - It stops reading the file directly; on Windows another program running as the same user can still decrypt it through
    DPAPI. The docs say so.

## Testing (AGENTS.md: tests at every level that fail without the feature)

- **Unit**: the `browser_*` tools are in the pre-allowed list of a Claude tab's settings; the pipe message parser (every
  op, bad args); the site gate (local hosts, subdomains, `www.`, IP literals,
  file URLs, redirects, tab vs always grants, timeouts with fake time); snapshot formatting from a recorded fake AX tree;
  profile store; `Local State` and `profiles.ini` parsing; mapping Chromium CDP cookies and Firefox rows to Electron cookie
  details (`__Host-`, `__Secure-`, SameSite values, expiry conversion, host-only vs domain cookies).
- **Integration**: the MCP tool → pipe round trip against a fake pipe server; the Firefox reader on a `cookies.sqlite`
  with a live WAL built under `tmpdir()`; the Chromium reader against a **stand-in browser** (a small script that speaks
  CDP over fd 3/4 and returns invented cookies), including the "file is locked" wait and the cleanup of the copy on
  success, failure and cancel; source discovery with `HOME`/`APPDATA`/`LOCALAPPDATA` pointed at fake profile trees.
- **E2E** (the app, fake `claude`, a local HTTP server started by the test): the Browser panel in a Claude tab; pipe
  messages as the MCP server sends them drive navigate/snapshot/click/type/screenshot and the panel shows the result; a
  non-local site (test mode maps `*.test` to 127.0.0.1 with `host-resolver-rules`) shows the card, and Allow / Always /
  Deny / timeout behave as specified; a click and a redirect from a local page to a `*.test` site are held until the
  card is answered; the card's attention is not sent to a paired device; Stop and Hand back; two Claude tabs keep separate pages; profile switch; Settings ›
  Browser (add, rename, delete, default, always-allowed list); import from a fake Firefox profile and from a stand-in
  Chromium browser into a profile, then a page on the local server sees the imported cookie; pages restored after a
  restart.
- **Opt-in real-browser test** (not in the default run): `CLAUDETERM_REAL_BROWSER_TEST=1` runs the import against the
  installed Chrome with a throwaway profile it creates under `tmpdir()`. It exists to re-check the `v20` path when Chrome
  changes.
- No test reads a real browser profile or starts a real browser in the default run; no real cookie values anywhere.

## Risks and what to check first

1. **The import spike** (see Approaches): the whole Windows Chromium import rests on it.
2. **Hidden pages**: a `WebContentsView` that is not shown (another tab in front, panel closed) must still load, run,
   take CDP input and give screenshots. Check early; if a removed view stops painting, keep views attached with zero
   opacity / off the visible area, or capture with `stayHidden`.
3. **Overlays over native views**: list every overlay that can cover the panel (menus, popovers, dialogs, lightbox,
   toasts, note overlay) and make each hide the page while open.
4. **DevTools and the debugger together**: if they cannot coexist, leave "Open DevTools" out of v1.
5. **Session cookies after restart**: see Cookie import.

## Left to the builder

- Exact wording of messages (meaning as above), icons, the shortcut if `Ctrl+Shift+B`/`⌘B` is taken.
- The snapshot text format details and size limit; screenshot format and maximum size.
- Where on each OS each browser's user-data folder and binary are found (known install paths, registry App Paths on
  Windows), and whether to add Chrome Beta/Canary, Opera and Arc.
- How to detect the locked cookie file (try to open/copy it) and which files the copy needs (from the spike).
- Ring buffer sizes, time limits within the ranges above, the order of the plan's tasks after the spike.
