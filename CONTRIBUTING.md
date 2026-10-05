# Contributing to ClaudeTerm

Thanks for helping! Bug reports, ideas, docs fixes and code are all welcome.

- **Found a bug?** [Open a bug report](https://github.com/DmVergasov/ClaudeTerm/issues/new?template=bug_report.yml). Logs from `%APPDATA%\ClaudeTerm\logs` help a lot.
- **Have an idea?** [Open a feature request](https://github.com/DmVergasov/ClaudeTerm/issues/new?template=feature_request.yml) before writing a large change, so we can agree on the approach first.
- **Looking for something to work on?** Issues labelled [`good first issue`](https://github.com/DmVergasov/ClaudeTerm/labels/good%20first%20issue) are a good start.
- **Security issue?** Please don't open a public issue — see [SECURITY.md](SECURITY.md).

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need **Windows 10 or 11**, **Node.js 22.12+** and **Git**. [Claude Code](https://docs.claude.com/en/docs/claude-code) is needed for trying Claude tabs by hand, not for the tests.

```powershell
git clone https://github.com/DmVergasov/ClaudeTerm.git
cd ClaudeTerm
npm ci
npm run dev
```

`npm run dev` runs the app with hot reload. A development copy keeps its data in `%APPDATA%\ClaudeTerm-dev` and listens on its own named pipe, so it does not interfere with an installed ClaudeTerm.

| Command | What it does |
|---|---|
| `npm run dev` | Run the app in development mode |
| `npm run typecheck` | TypeScript check of the app, the tests and the configs |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run test:e2e` | Build, then end-to-end tests against the real Electron app (Playwright) |
| `npm run screenshots` | Regenerate the README screenshots and the app icon |
| `npm run dist` | Build the installer into `dist\` |

## Project layout

```
src/
  main/       Electron main process: tabs and PTYs, settings, shell profiles, the named-pipe server,
              the image panel's sources (transcripts, folder watchers), the status bar state
  renderer/   UI in plain TypeScript (no framework): xterm.js terminals, tab bar, image panel,
              lightbox, status bar
  preload/    The window.ct bridge between renderer and main
  shared/     Types, IPC channel names and the named-pipe protocol shared by all parts
  hook/       Script Claude Code runs for its hooks and statusLine; reports to the app over the pipe
  mcp/        The show_image MCP server
tests/
  unit/  integration/  e2e/  screenshots/  fixtures/
build/        Installer resources (icon, NSIS script adding the Explorer menu item)
docs/         README images, design notes
```

The original design notes and implementation plans are in [`docs/superpowers`](docs/superpowers) (written in Russian). They explain why things are the way they are.

## Making a change

1. Fork the repository and create a branch from `master`.
2. Write a failing test first, then the code that makes it pass. Pure logic gets a unit test; anything that crosses a process boundary (the pipe, the hook script, transcripts on disk) gets an integration test; visible behaviour gets an e2e test.
3. Keep `npm run typecheck`, `npm test` and `npm run test:e2e` green.
4. If your change affects what the README shows, run `npm run screenshots` and commit the updated images.
5. Open a pull request and fill in the template.

### Guidelines

- **Match the surrounding code.** TypeScript in strict mode, small focused modules, no UI framework in the renderer.
- **Never print to stdout from the hook script.** Claude Code adds `SessionStart` hook output to the conversation and shows `statusLine` output in its UI. The hook must always exit with code 0, quickly, even when ClaudeTerm isn't running.
- **Treat everything from the pipe and from transcript files as untrusted.** Any local process can write to the pipe, and transcript formats change between Claude Code versions: validate, and degrade gracefully.
- **Keep the renderer sandboxed.** It reaches the system only through the preload bridge, and images only through the `ctimg://` protocol.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org): `feat: …`, `fix: …`, `docs: …`, `test: …`, `chore: …`.

## Releases

Maintainers release by bumping `version` in `package.json` and pushing a matching tag:

```powershell
git tag v0.2.0
git push origin v0.2.0
```

The **Release** workflow runs the tests, builds the installer and publishes it as a GitHub Release with generated notes.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
