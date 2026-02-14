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

ALLOW='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'

# ── Auto-allow read-only Bash commands ──────────────────
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
if [ "$TOOL_NAME" = "Bash" ]; then
  CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
  # Strip leading whitespace/env-vars/sudo, extract first word
  FIRST_CMD=$(echo "$CMD" | sed 's/^[[:space:]]*//' | sed 's/^sudo[[:space:]]*//' | awk '{print $1}')
  # Strip any path prefix (e.g. /usr/bin/ls → ls)
  FIRST_CMD=$(basename "$FIRST_CMD" 2>/dev/null || echo "$FIRST_CMD")

  case "$FIRST_CMD" in
    # Filesystem read-only
    ls|find|stat|file|du|df|tree|wc|realpath|dirname|basename)
      echo "$ALLOW"; exit 0 ;;
    # Content read-only
    cat|head|tail|less|more|strings|xxd|hexdump)
      echo "$ALLOW"; exit 0 ;;
    # Search tools
    grep|rg|ag|ack|fgrep|egrep)
      echo "$ALLOW"; exit 0 ;;
    # Text processing (read-only)
    awk|sed|sort|uniq|cut|tr|diff|comm|paste|column|fold|fmt|expand|unexpand|tee)
      echo "$ALLOW"; exit 0 ;;
    # Shell info
    pwd|which|whereis|type|echo|printf|date|uname|whoami|id|hostname|env|printenv|test|\[)
      echo "$ALLOW"; exit 0 ;;
    # Git read-only
    git)
      GIT_SUB=$(echo "$CMD" | sed 's/^[[:space:]]*//' | sed 's/^sudo[[:space:]]*//' | awk '{print $2}')
      case "$GIT_SUB" in
        status|log|diff|show|branch|tag|remote|rev-parse|ls-files|ls-tree|shortlog|describe|blame|stash\ list|config\ --get*)
          echo "$ALLOW"; exit 0 ;;
      esac
      ;;
    # Package info (read-only)
    npm)
      NPM_SUB=$(echo "$CMD" | sed 's/^[[:space:]]*//' | awk '{print $2}')
      case "$NPM_SUB" in
        ls|list|info|view|show|outdated|audit|why|explain)
          echo "$ALLOW"; exit 0 ;;
      esac
      ;;
    # Other read-only
    jq|xargs|gh)
      echo "$ALLOW"; exit 0 ;;
  esac
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
