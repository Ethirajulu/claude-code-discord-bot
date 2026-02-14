#!/bin/bash
# ─────────────────────────────────────────────────────────
# Install Claude Code hooks globally
#
# This copies the hook scripts to ~/.claude/hooks/ and
# adds the hook configuration to ~/.claude/settings.json
# so they fire for ALL your projects automatically.
# ─────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$HOME/.claude/hooks"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "🔧 Claude Code Remote — Hook Installer"
echo "========================================"
echo ""

# 1. Copy hook scripts
mkdir -p "$HOOKS_DIR"
cp "$SCRIPT_DIR/.claude/hooks/stop-notify.sh" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/.claude/hooks/notification-notify.sh" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR/stop-notify.sh"
chmod +x "$HOOKS_DIR/notification-notify.sh"
echo "✅ Hook scripts copied to $HOOKS_DIR/"

# 2. Check for jq (required by hooks)
if ! command -v jq &> /dev/null; then
  echo "⚠️  jq is required but not installed."
  echo "   Install it: brew install jq (Mac) or sudo apt install jq (Linux)"
  exit 1
fi
echo "✅ jq found"

# 3. Update settings.json
if [ -f "$SETTINGS_FILE" ]; then
  # Check if hooks already exist
  if grep -q "stop-notify.sh" "$SETTINGS_FILE" 2>/dev/null; then
    echo "⚠️  Hooks already configured in $SETTINGS_FILE — skipping"
  else
    echo "⚠️  $SETTINGS_FILE exists. Adding hooks manually..."
    echo ""
    echo "Add this to your ~/.claude/settings.json:"
    echo ""
    cat <<'HOOKS_JSON'
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/stop-notify.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/notification-notify.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
HOOKS_JSON
  fi
else
  # Create new settings file
  cat > "$SETTINGS_FILE" <<'SETTINGS'
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/stop-notify.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/notification-notify.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
SETTINGS
  echo "✅ Created $SETTINGS_FILE with hook configuration"
fi

# 4. Remind about env vars
echo ""
echo "─────────────────────────────────────────────"
echo "📋 REQUIRED: Set these environment variables"
echo "─────────────────────────────────────────────"
echo ""
echo "Add to your ~/.bashrc, ~/.zshrc, or ~/.profile:"
echo ""
echo "  export DISCORD_WEBHOOK_URL=\"your_webhook_url\""
echo "  export ALLOWED_USER_ID=\"your_discord_user_id\""
echo ""
echo "Then restart your shell: source ~/.zshrc"
echo ""
echo "─────────────────────────────────────────────"
echo "✅ Done! Claude Code will now send Discord notifications."
echo "   Start the bot with: cd claude-discord-bot && npm start"
echo "   Then use Claude Code normally — hooks will auto-fire."
echo ""
