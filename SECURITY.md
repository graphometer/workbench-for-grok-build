# Security model

Graphometer Workbench is a local tool that holds a capability worth protecting: the page
drives an AI agent with write access to your disk. The design assumes that anything the
agent emits may be attacker-controlled (a prompt-injected file in a repository the agent
reads is all it takes), and that other local processes may probe the local port.

## The boundaries

- **Loopback only.** The server binds `127.0.0.1` and refuses the LAN address and `[::1]`.
  There is no remote surface, no telemetry, no analytics, and no third-party network call.
- **Per-run access token.** A fresh random token is minted at startup and carried in the
  startup URL. Every route — pages, assets, API, the event stream — returns 403 without
  it. The token is never written to a file, never appears in the event stream, and is
  redacted from error text.
- **Cross-site request forgery.** State-changing routes require the token in a custom
  header and pass Host and Origin checks; the framing attack is closed with
  `X-Frame-Options: DENY` and `frame-ancestors 'none'` on every response. These were
  demonstrated as live attacks before the fixes and demonstrated blocked after.
- **Agent output is hostile input.** Message text, plan markdown, tool names, filenames,
  session titles, error strings — all of it reaches the DOM as text nodes, never markup.
  There is no `innerHTML` in the page (a check enforces it), and a strict
  Content-Security-Policy (`default-src 'none'`, `script-src 'self'`, no inline code) is
  the backstop, verified by positive control.
- **Credentials.** The app never reads your API token. Exactly two retention-related
  fields leave the parse of `~/.grok/auth.json`, server-side, read by name; everything
  else — the token above all — is dropped and never returned, logged, stored, or
  displayed. A decoy-token fixture in the check suite proves the output shape. The app
  itself never writes that file.
- **Configuration integrity.** `~/.grok/config.toml` is hashed at startup and exit and
  the app reports whether it changed. When the retention switch asks the agent to update
  its own auth file, the file's digest is logged before and after — the app verifies
  outcomes by reading state back, never by trusting an acknowledgment.
- **Process cleanup.** The agent runs in its own process group; shutdown signals the
  group and verifies emptiness through `/proc` before claiming success. Descendants that
  deliberately leave the group (e.g. `setsid()`) cannot be reached by this mechanism —
  the app reports such survivors by PID instead of claiming a guarantee it does not have.

## What the token does not protect against

Any process running as **your user** can read the server's memory, your files, and your
`~/.grok` directory directly — the token protects the agent-driving capability from
*other browser pages and unprivileged local network probes*, not from software you run
with your own privileges. That boundary is the operating system's, not this app's.

## Reporting

Security reports: **hello@graphometer.ai**. Honest reports about claims that don't hold
on your machine are as welcome as vulnerability reports — this project's rule is that a
claim it cannot re-verify gets weakened or withdrawn, not defended.
