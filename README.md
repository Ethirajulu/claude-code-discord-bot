# 🤖 Claude Code Remote — Discord Bot + Hooks

Continue your Claude Code terminal sessions from your phone via Discord. Built on Claude Code's native hooks system — no tmux, no terminal exposure.

## How It Works

```
┌─────────────────┐     Hook fires     ┌──────────────┐
│  Claude Code     │ ──────────────────→│   Discord    │
│  (your terminal) │     (Stop /        │  (your phone)│
│                  │   Notification)    │              │
│                  │ ←──────────────────│  Your reply  │
│  --resume <id>   │   Bot runs claude  │              │
└─────────────────┘    -p with resume   └──────────────┘
```

1. **You work in Claude Code normally** in your terminal
2. **When Claude finishes** → Stop hook sends the result to Discord
3. **When Claude wants to use a tool** (Edit, Write, Bash, etc.) → PreToolUse hook sends permission request to Discord
4. **You click Allow/Deny/Allow All/Modify** → Bot approves/denies in Claude Code
5. **You reply in Discord** → Bot runs `claude -c -p "your reply"` (continue mode) in the same project directory
6. **Response comes back** to Discord

No raw terminal access. Claude Code's safety guardrails stay intact — including a permission approval system that lets you control tool access remotely.

## Setup (10 minutes)

### Step 1: Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. **New Application** → name it (e.g., "Claude Remote")
3. **Bot** tab → uncheck **"Public Bot"** → **Reset Token** → copy it
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. **OAuth2 → URL Generator** → Scopes: `bot` → Permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Manage Messages`, `Embed Links`
6. Open the generated URL → invite bot to your server

### Step 2: Create a Discord Webhook

1. In your Discord server → go to the channel you want notifications in
2. **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook**
3. Copy the webhook URL

### Step 3: Get Your Discord User ID

1. Discord **Settings → Advanced → Enable Developer Mode**
2. Right-click your username → **Copy User ID**

### Step 4: Configure

```bash
cd claude-discord-bot
cp .env.example .env
```

Edit `.env`:
```
DISCORD_BOT_TOKEN=<your bot token from step 1>
ALLOWED_USER_ID=<your user ID from step 3>
DISCORD_WEBHOOK_URL=<your webhook URL from step 2>
NOTIFICATION_CHANNEL_ID=<channel ID where webhook posts>
BOT_PASSPHRASE=mysecretphrase   # optional but recommended
```

### Step 5: Install Hooks

```bash
# Make hook scripts executable
chmod +x .claude/hooks/*.sh

# Install globally (for all projects)
chmod +x install-hooks.sh
./install-hooks.sh

# Add env vars to your shell
echo 'export DISCORD_WEBHOOK_URL="your_webhook_url"' >> ~/.zshrc
echo 'export ALLOWED_USER_ID="your_discord_user_id"' >> ~/.zshrc
echo 'export PERMISSION_PORT="3847"' >> ~/.zshrc
source ~/.zshrc
```

### Step 6: Run the Bot

```bash
npm install
npm start
```

### Step 7: Keep It Running (optional)

```bash
# Using pm2
npm install -g pm2
pm2 start bot.js --name claude-remote
pm2 save && pm2 startup

# Or using nohup
nohup node bot.js > bot.log 2>&1 &
```

## Usage

### Automatic Flow (just use Claude Code normally)

```
Terminal:  claude
           > Refactor the auth module to use JWT

[Claude works... finishes]
[Discord notification appears on your phone]

Discord:   ✅ Claude Code Finished
           📁 Project: my-app
           🌿 Branch: feature/auth

You reply:  Now add unit tests for the JWT validation

[Bot resumes the session, sends response back]

Discord:   I've created test files for the JWT validation...
```

### Commands

| Command | Description |
|---|---|
| `!help` | Show help |
| `!status` | Active session, queue, and lock status |
| `!sessions` | List all tracked sessions |
| `!switch <id>` | Switch to a different session |
| `!clear` | Clear all sessions and permission overrides |
| `!queue` | View pending jobs |
| `!cancel` | Clear the queue |
| `!lock` | Lock the bot |
| `!unlock <phrase>` | Unlock with passphrase |
| `!permissions` | View tools allowed for current session |

### Permission Approval

When Claude wants to use a restricted tool (Edit, Write, Bash, etc.), the bot sends a permission request to Discord:

- **Allow** — Approve this one use
- **Deny** — Block this use
- **Allow All** — Auto-approve all future uses of this tool in this session
- **Modify** — Edit the tool input (e.g., change a command) then approve

The bot shows the tool name and input preview, so you can review before approving.

### Multiple Sessions

If you're working on multiple projects, hooks report all of them. Use `!sessions` to see them and `!switch` to change which one receives your messages:

```
!sessions
→ 1. abc123... — my-app (feature/auth) — 2m ago ← active
→ 2. def456... — api-service (main) — 15m ago

!switch def456
→ ✅ Switched to api-service (main)
```

## Architecture

```
~/.claude/settings.json          Your Claude Code hooks config
~/.claude/hooks/
  ├── stop-notify.sh             Fires on Stop → posts to Discord webhook
  ├── notification-notify.sh     Fires on Notification → pings you
  └── permission-bridge.sh       Fires on PreToolUse → requests Discord approval

claude-discord-bot/
  ├── bot.js                     Discord bot: runs prompts, approves permissions
  ├── .env                       Your configuration
  └── .claude/
      ├── settings.json          Project-level hook config (alternative)
      └── hooks/
          ├── stop-notify.sh
          ├── notification-notify.sh
          └── permission-bridge.sh

Permission Flow:
  Claude wants to Edit file
    ↓
  PreToolUse hook fires
    ↓
  permission-bridge.sh POSTs to localhost:3847
    ↓
  Bot sends Discord embed with buttons
    ↓
  You click Allow/Deny/Allow All/Modify
    ↓
  Bot responds to hook script
    ↓
  Claude Code proceeds/blocks
```

## Security

- **Private bot** — only you can invite it, only your user ID can use it
- **Passphrase lock** — optional passphrase required before bot accepts prompts
- **Auto-lock** — locks after configurable minutes of inactivity
- **No terminal exposure** — bot only calls `claude -c -p`, not raw shell
- **Claude Code guardrails** — all safety checks remain active, including the permission approval system
- **Permission approval** — you control which tools Claude can use via Discord buttons
- **Tool modification** — use the "Modify" button to edit commands before approval (e.g., change `rm -rf` to `rm`)
- **Passphrase auto-deletion** — unlock messages are deleted to keep the passphrase out of chat history
- **Base tools auto-allowed** — safe tools (Read, Grep, Glob, WebSearch) bypass permission buttons

## Cost

- **Discord**: Free (bot + webhook)
- **Claude Code**: Uses your existing subscription (Pro/Max) or API credits
- **The hooks + bot**: Run on your local machine — no server costs

## Troubleshooting

| Issue | Fix |
|---|---|
| No notifications in Discord | Check `DISCORD_WEBHOOK_URL` env var is set in your shell |
| No permission buttons appear | Ensure `NOTIFICATION_CHANNEL_ID` is set in .env; bot needs a channel to post buttons |
| Bot doesn't respond | Verify `ALLOWED_USER_ID` and `DISCORD_BOT_TOKEN` in .env |
| "No active session" | Claude Code hasn't fired a hook yet — run something in Claude Code first |
| Permission times out (no button click) | Button waits 10 minutes; click to approve or deny, or restart bot to reset |
| "No permission to edit" message shows up | Bot isn't running on port 3847, or `PERMISSION_PORT` env var isn't exported. Restart bot and check `echo $PERMISSION_PORT` |
| Claude can't use Edit/Write tools | You need to click "Allow" or "Allow All" on the permission button in Discord |
| Hooks not firing | Run `claude --debug` to check hook execution, or type `/hooks` inside Claude Code |

## Requirements

- Node.js 18+
- Claude Code CLI installed and authenticated
- `jq` installed (used by hook scripts to parse JSON)
- Discord account with a private server
