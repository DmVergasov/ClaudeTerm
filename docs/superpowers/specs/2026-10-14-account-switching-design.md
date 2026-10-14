# Account switching — design

Date: 2026-10-14. Status: approved in chat (approach A: a token per extra account).

## Goal

Switch the Claude subscription account a Claude tab runs on in one click, for two cases:

1. **The limit ran out.** One subscription hit its 5-hour or weekly limit; the user continues the same conversation on another subscription.
2. **Work and personal.** Some tabs run on one account, others on another, at the same time.

## Background

Claude Code has no account switcher. It offers two documented ways to run on more than one account
([authentication](https://code.claude.com/docs/en/authentication.md), [env vars](https://code.claude.com/docs/en/env-vars.md)):

- **A `CLAUDE_CONFIG_DIR` per account.** Each folder has its own login, settings, plugins, MCP servers, memory and
  history, so a conversation started on one account cannot be resumed on another.
- **`claude setup-token`** prints a one-year token for a Pro, Max, Team or Enterprise plan. A process given it in
  `CLAUDE_CODE_OAUTH_TOKEN` uses it instead of the saved login. Such a token "can only make model requests": no
  claude.ai connectors and no Remote Control; `/usage` may not work either (reported, not documented).

Swapping `.credentials.json` is not supported: the login's refresh token rotates and concurrent sessions race on it.

ClaudeTerm uses the token: the configuration stays shared, so a conversation can move between accounts, and
ClaudeTerm writes nothing into Claude Code's files.

## What the user sees

UI strings are English.

### Accounts

- **Main account** is the user's normal Claude Code login. ClaudeTerm does not touch it.
- **Extra accounts** are a name and a token, added in Settings → **Accounts**.
- The Accounts section lists each extra account with its name and `token valid until about <added + 1 year>`, and
  the actions **Rename**, **Replace token** and **Delete**.
- **Add account** shows a name field, a token field and **Get a token**. **Get a token** opens a tab in the main
  window running `<claude.command> setup-token` and brings the window to the front. The user signs in with the
  wanted account in the browser, copies the token from the terminal and pastes it into the field.
- A token is never shown again after it is saved, nor sent to the renderer.
- An account whose token cannot be decrypted (the data folder moved to another machine or user) is marked
  `token cannot be read — replace it`.
- **Delete** asks once more in place (**Delete** → **Confirm delete**). Tabs running on the account keep running;
  they move to the main account the next time they start.
- Names are 1–40 characters after trimming, unique ignoring case, and not `Main account`.
- When the system has no keyring (Linux without one), the section says
  `No system keyring: tokens are stored unencrypted, readable only by your user.` once an account exists: with no
  account the keyring is never asked, because on Linux that could mean an unlock prompt at every start.

### Switching a tab (the limit ran out)

- The tab's right-click menu of a Claude tab gets **Continue as <account>** for every account except the tab's
  own, `Main account` included, once at least one extra account exists.
- It works like **Restart session**: Claude Code stops and starts again with `--resume` of the tab's current
  conversation, now on the chosen account. A conversation without a transcript yet starts fresh, as Restart does.
  An exited tab simply starts.
- The status bar of a Claude tab shows the tab's account (`Main account`, `Personal`) once at least one extra
  account exists; a tab on a deleted account shows `Removed account`. A click on it opens the same menu of
  **Continue as …** items. The segment shows even before Claude Code reports its first status.
- The window title of a Claude tab on an extra account names the account before `ClaudeTerm`
  (`<title> — <folder> — Personal — ClaudeTerm`); the main account is left out.

### New tabs (work and personal)

- The ▾ menu, once at least one extra account exists, lists **Claude Code — <account>** for every account, the main
  one included, right after **Claude Code**.
- **Claude Code**, Ctrl+Shift+L, **Recent sessions…** and `--claude <dir>` start on the account of the active tab
  when it is a Claude tab, else on the main account.

### Restart and restore

- **Restart session** keeps the tab's account.
- The session snapshot keeps each tab's account; **Restore previous session** reopens tabs on their accounts.
- A tab whose account was deleted, or whose token cannot be read, starts on the main account with the toast
  `Account "<name>" is not available; the tab started on the main account` (`The account is not available; …` when
  the name is gone). It does not fail to open, so a restore never loses a tab.

## How it works

### Storage — `src/main/accounts.ts`

- File `<dataDir>/accounts.json`: `{ version: 1, accounts: [{ id, name, addedAt, token, encrypted }] }`. `id` is a
  UUID, `addedAt` an ISO date, `token` the base64 of `safeStorage.encryptString(token)` when `encrypted`, else the
  token itself.
- Written atomically (temporary file, then rename) with mode 0600, like Claude Code's own `.credentials.json`.
- Encryption is Electron `safeStorage` (DPAPI on Windows, the keyring on Linux). It is used when
  `isEncryptionAvailable()` and, on Linux, the backend is not `basic_text`; otherwise the token is stored as is and
  `encrypted` is `false`. The store takes encrypt/decrypt and the keyring state as dependencies, so unit tests run
  without Electron.
- Parsing degrades gracefully: an unreadable file gives no accounts, and the first change after that moves it to
  `accounts.json.broken` before writing a new one; an entry with a wrong shape is skipped.
- `AccountStore`:
  - `list(): AccountView[]` — `{ id, name, addedAt, readable }`, no token;
  - `add(name, token)`, `rename(id, name)`, `setToken(id, token)`, `remove(id)`;
  - `token(id): string | null` — decrypts, for the launch only; `null` when unknown or unreadable;
  - `keyring(): boolean` — whether tokens are encrypted.
- A token is 20–500 printable ASCII characters. All whitespace is removed first: a token has none, and one copied
  from a terminal keeps the line breaks its output was wrapped at. The format is not documented, so no prefix is
  required.
- Tokens never reach logs, toasts or error messages.

### Launch

- `OpenTabRequest.account?: string | null` and `TabInfo.account: string | null`; `null` is the main account.
  `undefined` in a request means "inherit": main takes the account of the active tab when it is a Claude tab.
- `ResolvedLaunch` gets `env: { set: Record<string, string>; unset: string[] }`, and `TabManager.start` applies it
  on top of `baseEnv()`.
- For an extra account: set `CLAUDE_CODE_OAUTH_TOKEN`; unset `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`,
  which Claude Code ranks above the token. For the main account the environment stays as it is today.
- `resolveLaunch` falls back to the main account (and reports it) when the account is unknown or its token cannot
  be read; main then shows the toast above.
- The **Get a token** tab is a shell tab on the Claude tabs' shell profile, titled `Get a token`, whose command
  line is `<claude.command> setup-token` (built like the Claude command line, without `--settings`). It runs on the
  main account's environment.

### Switching — `TabManager.switchAccount(tabId, account)`

1. Resolves the launch for the new account first. When the account is not available, nothing changes: the tab
   keeps its account, Claude Code is not restarted, and main toasts `Account "<name>" is not available`. Silently
   continuing on another account would be worse than not switching.
2. Otherwise sets `info.account`, emits `updated`, saves the snapshot and restarts like `restart(tabId, { live: true })`
   with `--resume` of the current conversation.

`restart` keeps using `info.account`.

### Snapshot

`SessionSnapshotTab.account: string | null`. `parseSnapshot` reads a string `account` and treats a missing or
non-string one as `null`, so snapshots written before this change restore on the main account.

### IPC

| Channel | Kind | Arguments |
|---|---|---|
| `accounts:list` | invoke | → `{ accounts: AccountView[], keyring: boolean }` |
| `accounts:add` | invoke | `name`, `token` → `{ ok: true } \| { ok: false, error }` |
| `accounts:rename` | invoke | `id`, `name` → same |
| `accounts:set-token` | invoke | `id`, `token` → same |
| `accounts:remove` | invoke | `id` → same |
| `accounts:get-token` | send | opens the **Get a token** tab |
| `tabs:switch-account` | send | `tabId`, `account: string \| null` |
| `ev:accounts` | event | the list, to the main window and the settings window after every change |

Main checks every argument: account references with `ipc-guards.ts`, names and tokens in `AccountStore` as above.
`tabs:open` checks `account` too.

### Renderer

- `src/renderer/accounts-section.ts` — the Accounts section of the settings window, its own IPC (accounts are not
  `SettingKey`s, which hold only plain values).
- `src/renderer/status-bar.ts` — the `account` segment, shown for a Claude tab when extra accounts exist.
- `src/renderer/main.ts` — the ▾ menu items, the tab menu items, the segment's click; the account list kept from
  `ev:accounts`.
- `src/preload` — the new `window.ct` methods.

## Out of scope

Switching automatically when a limit runs out; showing the email or plan of a token account; a config folder per
account (approach B); catching the token from the `setup-token` tab's output; warning before a token expires;
accounts inside WSL.

## Testing

No test runs the real `claude` or uses a real token.

- **Unit:**
  - `AccountStore` with fake crypto and an in-memory file: add, rename, replace, remove; name and token checks;
    duplicate and reserved names; an unreadable token gives `readable: false` and `token() === null`; a broken
    file gives no accounts; `list()` holds no token.
  - The launch environment: an extra account sets the token and unsets the API keys; the main account changes
    nothing; an unknown account falls back to main and reports it.
  - `parseSnapshot` with and without `account`.
  - `TabManager`: `switchAccount` restarts with `--resume` on the new account; an unavailable account changes
    nothing and does not restart; `restart` keeps the account; `open` without an account inherits from the active
    Claude tab.
  - The status bar's `account` segment.
- **Integration:** `accounts.json` on disk is written atomically, with mode 0600 on Linux.
- **E2E** (the stand-in `claude` prints the token variable; on Linux the app starts with `--password-store=basic`,
  so `safeStorage` does not wait for a keyring under xvfb):
  - add an account in the settings window; the token field is empty afterwards and the list shows the name;
  - ▾ → **Claude Code — Personal** prints the account's token in the terminal;
  - the tab menu's **Continue as Main account** restarts the tab with `--resume <id>` and without the token;
  - a click on the status bar's account segment switches the account;
  - **Restore previous session** reopens the tab on its account;
  - **Get a token** opens a tab running `fake-claude setup-token`.
- **By hand, on real accounts, after the implementation:** whether Claude Code shows the 5h/7d limits in the status
  bar for a session on a token, and what `/status` says. Without the limits those segments are simply absent.

## Docs

README: a short **Accounts** section (adding an account, switching a tab, what a token account cannot do).
