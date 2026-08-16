# Graphometer Workbench for Grok Build

**A local web interface for the [Grok Build](https://x.ai) CLI — built for people who
direct AI agents but do not write the code themselves.**

*for Grok Build · not affiliated with xAI*

Grok Build already ships subagents, worktrees, skills, a real context accounting system and
per-change tracking — all of it invisible outside a full-screen terminal UI. Graphometer
Workbench is a window onto that machinery: it adds visibility and reach, never new agent
capability. Everything on screen is something the agent actually reported; nothing is
invented, estimated, or silently dropped.

## What it does

- **Review and undo the agent's changes, per change.** Every changed file with real
  `+N/−M` counts, expandable to before/after per change, with agent-versus-human
  attribution — *Undo this change* reverts the agent's edit and leaves yours untouched.
- **Answer the agent in its own words.** Permission, plan-approval and question cards
  render inline in the conversation using the agent's own option labels, verbatim — never
  an invented button, never an auto-approval. If the agent offers no options, the app
  refuses visibly rather than guessing.
- **An honest context meter.** The segments genuinely sum to the window; overlapping
  categories are listed beside the bar, not stacked into it (the naive stacking would
  overstate context pressure by 68%). A live mid-turn tick was built, measured dishonest
  on the wire, and reverted — the meter reads what the agent reports, or nothing.
- **Survives the agent dying.** Kill the agent mid-turn and the page narrates the death,
  the automatic respawn, and each session's recovery — it never shows a blank page and
  never claims recovery it can't verify.
- **Multi-session.** Every session on the machine in one rail, grouped by folder — several
  live at once on one agent process, each streaming to its own pane. Rename, archive,
  delete, export/import.
- **A privacy panel that tells the truth.** Your coding-data retention and zero-data
  retention state, each with its source and its real lever named. The one setting that is
  changeable is changed through the agent's own protocol request — with the result
  verified by reading state back, never assumed from an acknowledgment.
- **Local-only, by construction.** Binds `127.0.0.1` only, per-run access token, strict
  Content-Security-Policy, zero telemetry, zero third-party calls. Every string the agent
  sends is treated as hostile input: text, never markup. See [SECURITY.md](SECURITY.md).

Behind that: 1,400+ deterministic checks run green, and the project's rule is that every
capability claim is proven on the wire or in a live browser before it is written down.

## Requirements

- **Linux** (tested) or **Windows via WSL2** — the process-safety machinery (process-group
  cleanup with `/proc` verification) is Linux-specific by design. macOS is unverified and
  not claimed.
- **Node.js 22+** (the server runs TypeScript directly — no build step, no dependencies,
  no `package.json`).
- **The Grok Build CLI**, installed and authenticated (`grok --version` — tested against `1.0.4`). The app drives `grok agent` over stdio; your existing login is used, and
  your token is never read by this app.

## Run

```bash
git clone https://github.com/graphometer/workbench-for-grok-build.git
cd workbench-for-grok-build
./start.sh
```

`start.sh` starts the server on port 4311 and opens your browser with the one-time access
URL (printed in the terminal if no browser opens). `Ctrl+C` stops it; `./stop.sh` from
another terminal also works, and shuts down cleanly — the agent process tree is verified
dead, and your `~/.grok/config.toml` is hash-checked unchanged on the way out.

Different port: `STUDIO_PORT=4318 ./start.sh`

## Configuration (optional)

Copy `graphometer.env.example` to `graphometer.env` next to `start.sh` — per-machine
settings, never tracked: workspace root for the folder picker, folders the app must never
list, default new-session folder, port.

Development surfaces (a raw wire view at `/bridge` and a Shell inspector tab) are compiled
out of the product build; start with `STUDIO_DEV=1` to get them.

## What this app never does

- Never sends anything anywhere except your local Grok Build agent.
- Never reads your API token (two named retention booleans are the only fields that ever
  leave `~/.grok/auth.json`'s parse, server-side).
- Never writes your agent configuration casually — `config.toml` is hashed before and
  after every run and the app reports if it changed; `auth.json` is written only by the
  agent itself, only when you flip the retention switch, and the result is digest-logged.
- Never renders agent output as markup — no innerHTML anywhere in the page, enforced by
  checks.

## Status

v1.0. Linux tested end-to-end against Grok Build 1.0.4 (and 1.0.0-1.0.3 before it).
Windows via WSL2 verified as a fresh install on a real Windows 11 machine — including the
shutdown behavior that the first attempt caught failing, which is why the launch suite now
reproduces that exact hang against the old code. Issues and honest platform reports
welcome. macOS reports especially — it remains unclaimed until someone proves it.

## License

[MIT](LICENSE) · built by Grant Williams — [graphometer.ai](https://graphometer.ai) —
with an AI build-and-review crew (Grok, Kimi, Codex, Claude). Graphometer is an
independent project and is not affiliated with, endorsed by, or sponsored by xAI.
