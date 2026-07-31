# Stealth Desktop IDE

A native editor with the Bandit agent built in. Same runtime as the
[CLI](./bandit-cli.html) and the [VS Code / Cursor extension](./bandit-stealth.html) —
this one is the whole editor rather than a panel inside someone else's.

Local-first by default: point it at a model on your own machine and nothing
leaves the box. Sign in to Bandit Cloud only if you want hosted models or
workspaces.

---

## Install

Downloads live at **[burtson.ai/stealth](https://burtson.ai/stealth)**.

| Platform | File | Notes |
|---|---|---|
| macOS | `.dmg` | Universal — Apple Silicon and Intel. Signed and notarized, so it opens without a warning. |
| Windows | `.msi` (or `.exe`) | Not code-signed yet — SmartScreen shows a one-time prompt. Choose **More info → Run anyway**. |
| Linux | `.AppImage`, `.deb`, `.rpm` | AppImage needs `chmod +x` before the first run. |

### First launch

On macOS you may see a keychain prompt: *"Stealth wants to use your
confidential information stored in ai.bandit.ide."* That is expected. The app
stores API keys and your session in the OS keychain rather than in browser
storage, and macOS binds keychain permission to an app's code signature — so a
newly-signed version asks once. Choose **Always Allow** and it stops asking.

Nothing is sent anywhere as a result of that prompt; it only unlocks local
credential storage.

---

## Updating

Stealth checks for updates on launch and every few hours while running. When
one is available a notice appears — accept it and the app downloads, verifies,
and restarts itself. **Help → Check for Updates** forces a check.

Updates are signed. The app verifies a signature against a key baked into the
binary before installing anything, so a tampered payload is rejected rather
than run.

---

## The editor

- **Files and tabs** — lazy-loaded tree, drag to reorder tabs, and a
  right-click menu for rename / duplicate / reveal / delete. Shift-click
  selects a range and Ctrl/Cmd-click toggles, so you can act on many files at
  once.
- **Language intelligence** — hover docs, go to definition / type definition /
  implementation, find references, rename, and format, backed by real language
  servers. Diagnostics are versioned against the document, so squiggles stay on
  the token they describe while you type.
- **Themes** — several built in, including a syntax palette that colours
  classes, interfaces, methods, and attributes rather than leaving everything
  one shade.

## Git

A Changes panel with per-file diffs, staging, commit, push/pull/fetch, and a
branch switcher that can create a branch as it checks out. Right-click a file
to view its diff, discard it, or add it (or its whole folder) to `.gitignore`.

## Terminal and debugging

A real integrated terminal, plus a bottom panel that switches between terminal
and debug output.

.NET debugging works out of the box: set breakpoints in the gutter, press play,
and step through with variables and a diagnostics widget fed by live counters.
The play button reflects your workspace — it names the project it will launch,
and disables itself with an explanation when the repo has nothing it can debug.
Other languages can still be run from the terminal.

---

## The agent

A chat sidebar drives the same agent the CLI and extension use: it reads and
searches the repo, plans, edits files, and runs commands, showing each tool call
as it happens. Every write is gated behind a diff you approve, and edits appear
live in any open editor.

### Skills

Workspace [skills](./skills.html) are picked up from `.bandit/skills/*.md` in
the repo you have open, and can be toggled per workspace. Because they live in
the repo, they are shared with everyone who clones it.

Everything else Bandit writes under `.bandit/` — turn journals, tool detail
blobs — is run history rather than source, and belongs in `.gitignore`:

```gitignore
.bandit/*
!.bandit/skills/
```

### Agents window

A second window that runs agents in the background, grouped by repository, so
long jobs keep going while you work elsewhere. Each session shows its own
transcript and a diff of what it changed — read from git rather than from the
agent's edit log, so several edits to one file collapse into one diff and
anything the agent later reverted correctly shows as nothing.

Open it from **Agents** in the top right, or from the welcome screen.

## Multiple windows

Right-click the dock or taskbar icon to open another window — useful for
working across several projects at once. One process owns every window, so
settings and sessions stay consistent. Clicking **IDE** or **Agents** focuses
an existing window of that kind before opening a new one.

---

## Signing in

Sign-in opens your real browser rather than an embedded webview, so you can see
the address bar and use your password manager. The app listens on a temporary
local port for the redirect and closes it as soon as the flow finishes — the
[loopback flow](https://datatracker.ietf.org/doc/html/rfc8252) native apps are
supposed to use.

You do not need an account to use Stealth with a local model.

---

## Where things live

| | |
|---|---|
| Workspace skills | `.bandit/skills/` in the open repo |
| Run history | `.bandit/turns/`, `.bandit/tool-details/` |
| Settings | `~/.bandit/config.json` |
| API keys and session | OS keychain (`ai.bandit.ide`) |

## Related

- [Configuration](./configuration.html) — models, providers, and settings
- [Skills](./skills.html) — what a skill is and how to write one
- [MCP connectors](./mcp.html) — attaching external tools
- [Bandit CLI](./bandit-cli.html) and the
  [VS Code / Cursor extension](./bandit-stealth.html)
