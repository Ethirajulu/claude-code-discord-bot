#!/bin/bash
# ─────────────────────────────────────────────────────────
# Claude Code Notification Hook → Discord Alert
#
# Fires when Claude Code needs your attention:
#   - Permission prompt (needs approval for a tool)
#   - Idle prompt (waiting for your input for 60+ seconds)
#
# This pings you on Discord so you can respond from your phone.
# ─────────────────────────────────────────────────────────

if [[ -z "$DISCORD_WEBHOOK_URL" ]]; then
  exit 0
fi

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "unknown"')
MESSAGE=$(echo "$INPUT" | jq -r '.message // "Claude needs your attention"')
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "Notification"')

PROJECT_NAME=$(basename "$CWD")
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Determine notification type and color
if echo "$MESSAGE" | grep -qi "permission"; then
  TITLE="🔐 Claude Needs Permission"
  COLOR=16776960  # Yellow
elif echo "$MESSAGE" | grep -qi "idle\|waiting\|input"; then
  TITLE="⏳ Claude is Waiting for Input"
  COLOR=15105570  # Orange
else
  TITLE="🔔 Claude Needs Attention"
  COLOR=3447003   # Blue
fi

# Escape message for JSON
MESSAGE_ESCAPED=$(echo "$MESSAGE" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')

PAYLOAD=$(cat <<EOF
{
  "content": "<@$ALLOWED_USER_ID>",
  "embeds": [{
    "title": "$TITLE",
    "description": "$MESSAGE_ESCAPED",
    "color": $COLOR,
    "fields": [
      { "name": "📁 Project", "value": "\`$PROJECT_NAME\`", "inline": true },
      { "name": "🔑 Session", "value": "\`${SESSION_ID:0:12}...\`", "inline": true },
      { "name": "📂 Directory", "value": "\`$CWD\`", "inline": false }
    ],
    "footer": { "text": "$TIMESTAMP" }
  }]
}
EOF
)

curl -s -o /dev/null -X POST "$DISCORD_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"

exit 0
