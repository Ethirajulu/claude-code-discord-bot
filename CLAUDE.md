# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Discord bot that bridges Claude Code terminal sessions to mobile. Uses Claude Code's native hooks system — when Claude finishes a task or needs permission, hooks post to Discord via webhooks. Users reply in Discord, and the bot runs `claude -c -p` (continue mode) in the correct project directory.

## Commands

```bash
npm start          # Run the bot
npm run dev        # Run with --watch (auto-restart on changes)
```

No test suite exists. Manual testing requires a running bot + Claude Code session + Discord.

## Architecture

**Single-file bot** (`bot.js`, ~1100 lines) with four internal classes:

- **SessionTracker** — in-memory session state parsed from webhook embeds (no database)
- **PromptQueue** — FIFO queue preventing concurrent Claude executions
- **SecurityLock** — optional passphrase with auto-lock timer
- **PermissionManager** — HTTP bridge for tool approval via Discord buttons

**Three hook scripts** (`.claude/hooks/`):

| Hook | Trigger | What it does |
|------|---------|-------------|
| `stop-notify.sh` | Claude finishes | Parses transcript JSONL, posts summary to Discord webhook |
| `notification-notify.sh` | Claude idle 60s+ | Posts attention-needed alert to Discord webhook |
| `permission-bridge.sh` | Claude wants a tool | POSTs to bot's HTTP server, waits for Discord button click |

### Key Data Flows

**Prompt flow:** Discord message → `PromptQueue` → `runClaudeContinue()` → `spawn("bash", ["-lc", "claude -c -p ..."])` with prompt piped via stdin → JSON response parsed → reply in Discord.

**Permission flow:** Claude Code fires PreToolUse hook → `permission-bridge.sh` POSTs to `localhost:$PERMISSION_PORT` → bot checks auto-allow rules → if not auto-allowed, sends Discord embed with Allow/Deny/Allow All/Modify buttons → user clicks → HTTP response returned to hook → Claude proceeds or blocks.

**Session tracking:** Hook scripts post webhook embeds to Discord → bot's `MessageCreate` handler parses embed fields → `SessionTracker.track()` stores sessionId + cwd + branch.

### The `CLAUDE_DISCORD_BOT` Gate

`permission-bridge.sh` is a global hook (installed to `~/.claude/hooks/`). To prevent it from hijacking interactive CLI sessions, the bot sets `CLAUDE_DISCORD_BOT=1` in the spawn env. The hook checks this variable — if unset, it immediately returns `"ask"` to defer to the normal terminal permission dialog.

## Environment Variables

**Bot (in `.env`):**
- `DISCORD_BOT_TOKEN` / `ALLOWED_USER_ID` — required
- `NOTIFICATION_CHANNEL_ID` — optional channel restriction
- `PERMISSION_PORT` — default 3847, HTTP server for hook↔bot communication

**Shell profile (for hooks, NOT in `.env`):**
- `DISCORD_WEBHOOK_URL` — hooks POST here; must be in `~/.zshrc` or equivalent
- `ALLOWED_USER_ID` — for @mention in notifications
- `PERMISSION_PORT` — must match bot's value

## External Dependencies

- `jq` — used by hook scripts for JSON parsing
- `git` — hooks detect branch via `git rev-parse`
- Claude Code CLI — must be installed and authenticated

## Design Decisions

- **`--continue` not `--resume`**: `-p --resume` has a bug (GitHub #1967). `--continue` picks up the most recent session in the cwd.
- **Stdin piping**: Prompt is written to `child.stdin` rather than passed as a CLI arg to avoid shell quoting issues.
- **localhost-only HTTP**: Permission server binds to `127.0.0.1` — hooks and bot must be on the same machine.
- **Base tools auto-allowed**: Read, Grep, Glob, LS, WebSearch bypass Discord buttons (defined in `BASE_ALLOWED_TOOLS`).
- **No persistent state**: Sessions are in-memory only; lost on bot restart. Hooks re-report on next Claude activity.

## Hook Installation

Hooks must be both in `.claude/hooks/` (project) and `~/.claude/hooks/` (global). Run `./install-hooks.sh` or manually copy and `chmod +x`. The global copy of `permission-bridge.sh` is what fires for all Claude Code sessions.
