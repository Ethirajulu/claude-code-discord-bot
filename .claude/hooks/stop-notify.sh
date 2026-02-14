#!/bin/bash
# ─────────────────────────────────────────────────────────
# Claude Code Stop Hook → Discord Notification
# 
# Fires when Claude Code finishes responding.
# Sends the session info to your Discord webhook so you
# can continue the conversation from your phone.
#
# Install: Copy to .claude/hooks/ in your project or ~/.claude/hooks/ globally
# Config:  Set DISCORD_WEBHOOK_URL environment variable
# ─────────────────────────────────────────────────────────

# Exit silently if no webhook configured
if [[ -z "$DISCORD_WEBHOOK_URL" ]]; then
  exit 0
fi

# Read JSON input from stdin (Claude Code sends hook context here)
INPUT=$(cat)

# Parse fields from the hook input
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "unknown"')
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "Stop"')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')

# Get project name from directory
PROJECT_NAME=$(basename "$CWD")

# Get git branch if available
GIT_BRANCH=$(cd "$CWD" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "N/A")

# Get timestamp
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Try to extract last assistant message from transcript for context
LAST_MESSAGE=""
if [[ -n "$TRANSCRIPT_PATH" && -f "$TRANSCRIPT_PATH" ]]; then
  # Get the last assistant message (truncated to 500 chars for Discord)
  LAST_MESSAGE=$(tail -20 "$TRANSCRIPT_PATH" | \
    jq -r 'select(.type == "assistant") | .message.content[] | select(.type == "text") | .text' 2>/dev/null | \
    tail -1 | \
    head -c 500)
  
  if [[ ${#LAST_MESSAGE} -ge 500 ]]; then
    LAST_MESSAGE="${LAST_MESSAGE}..."
  fi
fi

# Build Discord embed payload
if [[ -n "$LAST_MESSAGE" ]]; then
  DESCRIPTION="**Last response preview:**\n\`\`\`\n$(echo "$LAST_MESSAGE" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')\n\`\`\`"
else
  DESCRIPTION="Claude has finished responding."
fi

# Escape for JSON
DESCRIPTION_ESCAPED=$(echo "$DESCRIPTION" | sed 's/\\/\\\\/g')

PAYLOAD=$(cat <<EOF
{
  "embeds": [{
    "title": "✅ Claude Code Finished",
    "description": "$DESCRIPTION_ESCAPED",
    "color": 5763719,
    "fields": [
      { "name": "📁 Project", "value": "\`$PROJECT_NAME\`", "inline": true },
      { "name": "🌿 Branch", "value": "\`$GIT_BRANCH\`", "inline": true },
      { "name": "🔑 Session", "value": "\`${SESSION_ID:0:12}...\`", "inline": true },
      { "name": "📂 Directory", "value": "\`$CWD\`", "inline": false },
      { "name": "💬 Resume Command", "value": "Reply in Discord to continue, or run:\n\`\`\`\ncd '$CWD' && claude --resume $SESSION_ID\n\`\`\`", "inline": false }
    ],
    "footer": { "text": "$TIMESTAMP" }
  }]
}
EOF
)

# Send to Discord webhook
curl -s -o /dev/null -X POST "$DISCORD_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"

exit 0
