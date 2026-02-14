#!/bin/bash
# ─────────────────────────────────────────────────────────
# Claude Code Stop Hook → Discord Notification
# Fires when Claude Code finishes responding.
# Works on both macOS and Linux.
# ─────────────────────────────────────────────────────────

INPUT=$(cat)

# Guard: prevent infinite loops
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

WEBHOOK_URL="${DISCORD_WEBHOOK_URL}"
[ -z "$WEBHOOK_URL" ] && exit 0

# Parse hook input
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "unknown"')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')

PROJECT_NAME=$(basename "$CWD")
GIT_BRANCH=$(cd "$CWD" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "N/A")
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# ─── Reverse file reader (works on macOS and Linux) ───
reverse_file() {
  if command -v tac > /dev/null 2>&1; then
    tac "$1"
  else
    tail -r "$1"
  fi
}

# ─── Extract last meaningful assistant text from JSONL transcript ───
LAST_MSG=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  # Read transcript in reverse, find last assistant message with real text content.
  # Skip trivial messages like "No response requested." to find the actual response.
  LAST_MSG=$(reverse_file "$TRANSCRIPT_PATH" | while IFS= read -r line; do
    line_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
    if [ "$line_type" = "assistant" ]; then
      text=$(echo "$line" | jq -r '[.message.content[]? | select(.type == "text") | .text] | join("\n")' 2>/dev/null)
      # Skip trivial/empty responses
      if [ -n "$text" ] && [ "$text" != "No response requested." ] && [ "$text" != "null" ]; then
        echo "$text"
        break
      fi
    fi
  done)

  # If all assistant messages were trivial, just grab the last one anyway
  if [ -z "$LAST_MSG" ]; then
    LAST_MSG=$(reverse_file "$TRANSCRIPT_PATH" | while IFS= read -r line; do
      line_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
      if [ "$line_type" = "assistant" ]; then
        echo "$line" | jq -r '[.message.content[]? | select(.type == "text") | .text] | join("\n")' 2>/dev/null
        break
      fi
    done)
  fi

  # Truncate
  LAST_MSG=$(echo "$LAST_MSG" | head -c 500)
fi

[ -z "$LAST_MSG" ] && LAST_MSG="Claude finished. Check terminal for details."

# ─── Build payload with jq ───
PAYLOAD=$(jq -n \
  --arg preview "$LAST_MSG" \
  --arg project "$PROJECT_NAME" \
  --arg branch "$GIT_BRANCH" \
  --arg session_short "${SESSION_ID:0:12}..." \
  --arg cwd "$CWD" \
  --arg session_full "$SESSION_ID" \
  --arg timestamp "$TIMESTAMP" \
  '{
    username: "Claude Code",
    embeds: [{
      title: "✅ Claude Code Finished",
      description: ("```\n" + ($preview | .[0:500]) + "\n```"),
      color: 5763719,
      fields: [
        { name: "📁 Project", value: $project, inline: true },
        { name: "🌿 Branch", value: $branch, inline: true },
        { name: "🔑 Session", value: $session_short, inline: true },
        { name: "📂 Directory", value: ("`" + $cwd + "`"), inline: false },
        { name: "💬 Resume", value: ("Reply here to continue, or:\n```\ncd " + $cwd + " && claude --continue\n```"), inline: false }
      ],
      footer: { text: $timestamp }
    }]
  }')

curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$WEBHOOK_URL" > /dev/null 2>&1 &

exit 0