# The color theme colors the whole app — design

## Why

Settings → **Terminal theme** today colors the terminal and the chat only. Everything else keeps the dark Graphite colors: the
title bar, the tab bar and tab list, the side panels (Changes, Media, Docs, MCP · Plugins, Agent messages), the status bar, menus,
dialogs, toasts, the settings window and the Windows title bar buttons. In a light theme the chat is light inside a dark app.
The person wants the theme to apply to the whole app.

## Goals

- One theme setting colors every part of both windows (the main window and the settings window), the Windows title bar buttons and
  the windows' background while they load.
- Graphite looks exactly as today, color for color.
- A theme change applies at once, everywhere, without a restart.
- Light themes get a light scheme (`color-scheme: light`: native scrollbars, form controls).

## Non-goals

- New themes, a theme editor, or a separate theme per part.
- The lightbox backdrop (stays dark, for pictures) and a document's own white page in the Docs panel.
- Account badge colors (they tell accounts apart, they do not follow the theme).

## Approaches

1. **One palette for the app (chosen).** The palette the chat derives from the theme today (`chatPalette` in
   src/renderer/themes.ts) becomes the app's palette, set as CSS custom properties on `:root` of both windows; the hard-coded
   colors in the CSS become those properties. One source of truth, and the chat keeps working as it does.
2. A second, hand-made palette per built-in theme for the window chrome. Rejected: two palettes drift apart, and a custom theme
   (an object in settings.json) would have no chrome palette.

## Design

- **Palette.** The palette code moves to `src/shared` (pure functions: the main process needs the background and foreground for
  the window chrome). It returns every token `colors.css` defines today (`--ground`, `--sheet`, `--raised`, `--line`, `--text`
  …), the chat's tokens, and the few new ones the hard-coded colors need (a hover tint, the active tab, a scrim, the match
  highlight), and `color-scheme`. For Graphite it returns today's literal values. Light or dark: the background's luminance, as
  today.
- **Windows.** The main window and the settings window set the palette on `document.documentElement` at start and on every theme
  change; the chat no longer needs its own scoped copy (it inherits from `:root`).
- **CSS.** Every hard-coded color in `styles.css`, `settings.css`, `mcp/mcp.css` and `chat/chat.css` that is a surface, a text,
  a line, a hover or an accent becomes a palette property; the colors the non-goals keep stay.
- **Window chrome.** Main sets each window's `backgroundColor` and, on Windows, `setTitleBarOverlay({ color, symbolColor })` from
  the theme at creation and on every change.
- **Setting.** Its title becomes **Theme** (the key `theme` and its values stay).

## Tests

- Unit: the palette for Graphite equals today's colors (every `colors.css` token); a light theme gives a light scheme and light
  surfaces; a custom object theme gives a full palette.
- End-to-end: in One Half Light the title bar, the tab bar, the status bar, an open side panel, a menu and the settings window
  are light (their computed backgrounds); Graphite keeps today's colors; a theme change reaches every part at once; the window's
  title bar overlay color follows the theme (read from main in the test).

## Left to the builder

The new tokens' names and values for the non-Graphite themes (mixed from background and foreground as `chatPalette` mixes them),
the order of the CSS sweep.
