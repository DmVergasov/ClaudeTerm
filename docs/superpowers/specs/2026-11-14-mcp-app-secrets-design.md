# MCP app secrets: carried to an account, and asked for when missing — design

## Why

An MCP server can sign in through the person's own registered OAuth app (its config has `oauth.clientId`, like Asana's). Such an
app needs its client secret at sign-in; Claude Code keeps the secret apart from the config, in its sign-in store
(`.credentials.json` → `mcpOAuthClientConfig["<name>|<hash>"].clientSecret` on Windows and Linux, the Keychain on macOS).
ClaudeTerm's carry-over adds MCP servers to an extra account without any secret, so the server's sign-in fails there with
"Client authentication failed. Check that client_id and client_secret match your registered app." The person wants the carry-over
to be able to bring the secrets, as an option in the account window, and a way to give a server its secret when it has none.

## Goals

- The carry-over picker (Add account…, Carry over…) has an item **MCP app secrets**, right after **MCP servers**: the client
  secrets of the carried servers that have one in the source account. It counts them, it is off while **MCP servers** is off, and
  it is checked by default with the other items.
- Carrying it gives each such server in the target account the same client secret, through Claude Code's own
  `claude mcp add-json --client-secret` with `MCP_CLIENT_SECRET` (as the MCP panel already adds a server with a secret). A secret
  is never written to a log, a progress line or the window.
- In the MCP panel, a server whose sign-in failed because the app's client authentication failed shows, under its row, a
  **Client secret** field and **Save**: saving re-adds the server with that secret (same scope, same config), then the person
  signs in again. The ··· menu of a server with `oauth.clientId` has **Set client secret…**, which shows the same field.

## Non-goals

- Carrying sign-ins (access or refresh tokens): never.
- The carry item on macOS: Claude Code keeps the secrets in the Keychain there, which ClaudeTerm does not read; the item does not
  show on macOS, and the panel's field is the way.

## Approaches

1. **Read the source's secret file and re-add through the CLI (chosen).** Uses Claude Code's supported path to store a secret.
2. Write the target's `.credentials.json` directly. Rejected: its format is Claude Code's private business.

## Design

- **Counting** (main, carry preview): read the source account's `.credentials.json` (main account: `~/.claude/.credentials.json`;
  an extra account: its folder's), its `mcpOAuthClientConfig` entries with a non-empty `clientSecret`, matched to the carried
  servers by the name before `|`. Untrusted input: validate the shape, cap the size as the other carry reads do.
- **Carrying**: for each carried server with a secret, add it with `--client-secret` and `MCP_CLIENT_SECRET` in the target's
  environment instead of the plain add. The progress line reads like the others (`MCP app secrets: 1`).
- **Panel**: the sign-in result's error text containing `Client authentication failed` (or `invalid_client`) marks the row as
  needing a secret; the field is a password field; Save runs `mcp remove` then `mcp add-json --client-secret` for that server in
  the tab's account with the secret in `MCP_CLIENT_SECRET`, and masks the secret in any error text it shows.

## Tests

- Unit: the counting from a credentials object (matched names, empty or malformed entries skipped).
- Integration (the stand-in `claude`): a carry with the item on adds the server with `--client-secret` and the secret in the
  environment (the stand-in logs that a secret came, never its value); with the item off, without.
- End-to-end: the picker shows **MCP app secrets** with its count after **MCP servers** and turns it off with it; in the MCP panel
  a sign-in that fails with "Client authentication failed" shows the field, Save re-adds the server with the secret (the
  stand-in logs it), and the secret never shows in the window.

## Left to the builder

The stand-in's scripted failure text, the field's look, where the count's names show.
