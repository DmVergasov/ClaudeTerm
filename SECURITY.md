# Security Policy

## Supported versions

Security fixes go into the latest release. Please update to it before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub instead:
[**Report a vulnerability**](https://github.com/DmVergasov/ClaudeTerm/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You will get a reply within a week; once a fix is released, the advisory is published and you are credited unless you prefer otherwise.

## What is in scope

ClaudeTerm runs shells and Claude Code with your user's rights, so its interesting surfaces are where data from elsewhere reaches it:

- the named pipe (`\\.\pipe\claudeterm-<user>`) that the hook script and the `show_image` MCP server report to;
- the hook script and MCP server that Claude Code runs;
- files ClaudeTerm reads: Claude Code transcripts, images, `settings.json`;
- the renderer: terminal output, links, images shown through `ctimg://`;
- the installer and the Explorer context-menu entries it writes.

Bugs in Claude Code itself should go to [Anthropic](https://www.anthropic.com/responsible-disclosure-policy).
