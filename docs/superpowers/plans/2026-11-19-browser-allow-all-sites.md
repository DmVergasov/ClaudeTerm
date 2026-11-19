# Browser: Always allow all sites — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each browser profile gets an "Always allow all sites" switch in Settings › Browser. While it is on, Claude uses
any http/https site in that profile without a card.

**Architecture:** The profile store keeps a boolean per profile. A new profile action sets it, and the site gate asks the
store through a new `allowAll(profileId)` dependency before it covers a site. The settings row shows a switch and a
warning line, and dims the always-allowed list while the switch is on. Local files keep the tab-folder rule, because the
gate checks files before sites.

**Tech Stack:** Electron 44, strict TypeScript, plain-TS renderer, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-11-17-builtin-browser-design.md, section "Always allow all sites".

## Global Constraints

- Switch label, exact: `Always allow all sites`
- Warning line under it, always shown, exact: `Claude opens any website in this profile without asking, signed in with its cookies.`
- Default: off. An older store file, or a value that is not `true`, loads as off.
- New profile action, exact shape: `{ type: 'allowAll'; id: string; on: boolean }`
- No confirm dialog.
- Local files outside the tab's folder still ask with their own card, whatever the switch says.
- Local http pages stay free. Other schemes stay refused.
- A held form POST is still not sent again.
- The always-allowed list stays editable. While the switch is on it is dimmed, and it applies again when the switch is off.
- A card already waiting when the switch turns on stays until answered.
- No commits (the coordinator agrees the commit with the person). Run only the affected tests (AGENTS.md).
- Keep each file's line endings. No window `focus()` in tests. Temp files only under `tmpdir()`.

## Review Focus

1. An older `browser-profiles.json` with no `allowAll`, or a hand-edited `"allowAll": "yes"`, loads as off and is saved
   back as a boolean.
2. With the switch on, a `file://` page outside the tab's folder still shows its card.
3. Switching it off again brings the card back for the next command at once, and masks other-site pages in `tabs list`
   again, with no restart.
4. On for `Work` changes nothing for a tab on `Default`.
5. The guard refuses `on` that is not a boolean, and an id that fails `PROFILE_ID_RE`. `setAllowAll` on an unknown or
   removed profile returns false and saves nothing.

---

### Task 1: The switch, end to end

**Files:**
- Modify: `src/shared/browser.ts` (`BrowserProfileView` gains `allowAll: boolean`; `BrowserProfileAction` gains the new
  member)
- Modify: `src/main/browser/profiles-store.ts`: `StoredProfile.allowAll: boolean`, loaded as `p.allowAll === true`,
  `view()` includes it, `add()` creates it as false. New methods `allowsAll(id: string): boolean` (false for an unknown
  id) and `setAllowAll(id: string, on: boolean): boolean` (false for an unknown id or no change; saves on a change).
- Modify: `src/main/ipc-guards.ts`: `isBrowserProfileAction` gets `case 'allowAll': return id && typeof a.on === 'boolean'`.
- Modify: `src/main/index.ts` (~1003, `browserProfileAction`): `case 'allowAll': if (browserProfiles.setAllowAll(act.id, act.on)) profilesChanged()`.
- Modify: `src/main/browser/site-gate.ts`: `SiteGateDeps.allowAll(profileId: string): boolean`. In `isAllowed`, after the
  `isFileUrl` and `isLocalUrl` branches, an http(s) URL with a site is allowed when `this.d.allowAll(profileId)` is true,
  or when it is covered as today.
- Modify: `src/main/browser/browser-hub.ts` (~105): `allowAll: (profileId) => d.profiles.allowsAll(profileId)`.
- Modify: `src/renderer/browser-settings.ts` `profileRow`, and `src/renderer/settings.css`:
  - between the head and the sites, a `label.browser-allow-all` holding `input[type=checkbox].switch` (with
    `role="switch"`, `checked: p.allowAll`) and the label text;
  - under it, a `p.browser-allow-all-hint` with the warning line;
  - on change, `act({ type: 'allowAll', id: p.id, on: box.checked }, render)`;
  - while `p.allowAll` is on, `.browser-profile-sites` gets the class `is-dim`, styled with lower opacity and still
    clickable.
- Modify: README.md (the Browser section, near the cards): one line saying the switch exists and that, while it is on,
  Claude visits and acts on any site the profile is signed in to without asking. CHANGELOG.md `## 0.25.0`, `### New`:
  add the switch to the browser entry in one short sentence.
- Tests:
  - `tests/unit/browser-profiles-store.test.ts`
  - `tests/unit/site-gate.test.ts`
  - `tests/unit/ipc-guards.test.ts`
  - `tests/unit/browser-hub.test.ts`, if its gate fakes need the new dependency
  - `tests/unit/tab-browser.test.ts`, the same
  - `tests/e2e/browser-profiles.spec.ts`
  - `tests/e2e/browser-permission.spec.ts`

**Interfaces:**
- Produces: `BrowserProfilesStore.allowsAll(id): boolean`, `setAllowAll(id, on): boolean`; `SiteGateDeps.allowAll`;
  `BrowserProfileView.allowAll`; action `{ type: 'allowAll'; id; on }`.

- [ ] **Step 1: Write the failing unit tests**
  - **Store.**
    - A new profile has `allowAll: false` in `view()`.
    - `setAllowAll('default', true)` returns true, and a new store on the same file has it `true`.
    - The same value again returns false.
    - An unknown id returns false.
    - A file with no `allowAll` loads as false.
    - A file with `"allowAll": "yes"` loads as false.
  - **Guard.**
    - `{type:'allowAll', id:'default', on:true}` is accepted.
    - `on: 'true'`, a missing `on`, and `id: '../x'` are refused.
  - **Gate.**
    - With `allowAll` true for `work`, `isAllowed(tab, 'work', 'https://bank.example/x')` is true and `check` resolves
      `allowed` with no card.
    - For `default`, the same URL still gives a card.
    - With `allowAll` true, a `file://` URL outside the tab's folder still gives a file card.
    - Switching the fake to false makes `isAllowed` false again.

- [ ] **Step 2: Run them, and see them fail**

  Run: `npx vitest run tests/unit/browser-profiles-store.test.ts tests/unit/site-gate.test.ts tests/unit/ipc-guards.test.ts`

  Expected: FAIL. `allowsAll`, `setAllowAll` and `allowAll` are missing, and the guard refuses the action.

- [ ] **Step 3: Write the failing e2e tests**
  - **`browser-profiles.spec.ts`: "Always allow all sites is kept per profile".**
    - Open Settings › Browser. The Default row has an unchecked `role=switch` named `Always allow all sites`, and the
      exact warning line.
    - Click it, and `window.ct.browserProfiles()` reports `allowAll: true` for default.
    - The sites list has the `is-dim` class.
    - Close and reopen Settings: the switch is still checked.
  - **`browser-permission.spec.ts`: "with Always allow all sites on, Claude opens and reads other sites without a card".**
    1. Turn the switch on for the tab's profile through `window.ct.browserProfileAction` from the main page.
    2. `browser_navigate` to `http://other.test:<port>/...` answers without a card, and `gate`/panel shows no card.
    3. The person opens another other-site page, and `browser_tabs list` shows its full URL.
    4. A `file://` page in another temp folder still shows its card.
    5. Turn the switch off: the next navigate to a new other site shows the card again.

- [ ] **Step 4: Run them, and see them fail**

  Run: `npm run build`, then
  `npx playwright test tests/e2e/browser-profiles.spec.ts tests/e2e/browser-permission.spec.ts --project=e2e -g "Always allow all sites"`,
  with `CLAUDE_CONFIG_DIR` set to an empty temp folder.

  Expected: FAIL. There is no switch, and the card shows.

- [ ] **Step 5: Implement the store, guard, action, gate, hub wiring and settings row, as listed under Files**

- [ ] **Step 6: Run the unit tests and the two e2e tests, and see them pass**

- [ ] **Step 7: Update README and CHANGELOG** (one line each, CRLF kept), and the plan's Global Constraints of the
  browser plan, `docs/superpowers/plans/2026-11-17-builtin-browser.md`: add the two exact strings.

- [ ] **Step 8: Run the affected checks**
  - `npm run typecheck`
  - `npx vitest run` on the changed unit files
  - `npm run build`, then
    `npx playwright test tests/e2e/browser-profiles.spec.ts tests/e2e/browser-permission.spec.ts tests/e2e/browser.spec.ts tests/e2e/settings.spec.ts --project=e2e`

  Expected: all pass.

- [ ] **Step 9: Do not commit.** Leave the changes for the coordinator.
