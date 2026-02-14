#!/bin/bash
# ─────────────────────────────────────────────────────────
# Claude Code Notification Hook → Discord Alert
# Fires when Claude needs permission or is idle 60+ seconds.
# ─────────────────────────────────────────────────────────

INPUT=$(cat)

# Skip permission-related notifications (handled by PermissionRequest hook)
if echo "$INPUT" | grep -qi "permission"; then
  exit 0
fi

WEBHOOK_URL="${DISCORD_WEBHOOK_URL}"
[ -z "$WEBHOOK_URL" ] && exit 0

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "unknown"')
MESSAGE=$(echo "$INPUT" | jq -r '.message // "Claude needs your attention"')

PROJECT_NAME=$(basename "$CWD")
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Pick color and title based on notification type
if echo "$MESSAGE" | grep -qi "permission"; then
  TITLE="🔐 Claude Needs Permission"
  COLOR=16776960
elif echo "$MESSAGE" | grep -qi "idle\|waiting\|input"; then
  TITLE="⏳ Claude is Waiting for Input"
  COLOR=15105570
else
  TITLE="🔔 Claude Needs Attention"
  COLOR=3447003
fi

PAYLOAD=$(jq -n \
  --arg title "$TITLE" \
  --arg message "$MESSAGE" \
  --argjson color "$COLOR" \
  --arg project "$PROJECT_NAME" \
  --arg session_short "${SESSION_ID:0:12}..." \
  --arg cwd "$CWD" \
  --arg timestamp "$TIMESTAMP" \
  --arg user_id "${ALLOWED_USER_ID:-}" \
  '{
    content: (if $user_id != "" then ("<@" + $user_id + ">") else null end),
    username: "Claude Code",
    embeds: [{
      title: $title,
      description: $message,
      color: $color,
      fields: [
        { name: "📁 Project", value: $project, inline: true },
        { name: "🔑 Session", value: $session_short, inline: true },
        { name: "📂 Directory", value: ("`" + $cwd + "`"), inline: false }
      ],
      footer: { text: $timestamp }
    }]
  }')

curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$WEBHOOK_URL" > /dev/null 2>&1 &

exit 0