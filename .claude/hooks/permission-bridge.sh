#!/bin/bash
# ─────────────────────────────────────────────────────────
# Claude Code PreToolUse Hook → Discord Bot Bridge
# Reads tool call JSON from stdin, POSTs to the bot's HTTP
# server, and outputs the permission decision for Claude.
# ─────────────────────────────────────────────────────────

INPUT=$(cat)

# Only bridge to Discord when running from the bot
if [ -z "$CLAUDE_DISCORD_BOT" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}'
  exit 0
fi

PORT="${PERMISSION_PORT:-3847}"

RESPONSE=$(curl -s -f --max-time 590 \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$INPUT" \
  "http://localhost:${PORT}/permission-request" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  # Fallback: "ask" defers to normal permission flow.
  # Base tools covered by --allowedTools still work; others get denied in -p mode.
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}'
  exit 0
fi

echo "$RESPONSE"
exit 0
