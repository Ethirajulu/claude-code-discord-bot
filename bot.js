const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
} = require("discord.js");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ─── Configuration ───────────────────────────────────────
const CONFIG = {
  token: process.env.DISCORD_BOT_TOKEN,
  allowedUserId: process.env.ALLOWED_USER_ID,
  channelId: process.env.NOTIFICATION_CHANNEL_ID || null,
  webhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
  passphrase: process.env.BOT_PASSPHRASE || null,
  autoLockMinutes: parseInt(process.env.AUTO_LOCK_MINUTES) || 15,
  maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE) || 5,
  claudeTimeout: parseInt(process.env.CLAUDE_TIMEOUT_SECONDS) || 300,
};

if (!CONFIG.token || CONFIG.token === "your_bot_token_here") {
  console.error("❌ Set DISCORD_BOT_TOKEN in .env");
  process.exit(1);
}
if (!CONFIG.allowedUserId || CONFIG.allowedUserId === "your_user_id_here") {
  console.error("❌ Set ALLOWED_USER_ID in .env");
  process.exit(1);
}

// ─── Session Tracker ─────────────────────────────────────
// Tracks active Claude Code sessions reported by hooks
class SessionTracker {
  constructor() {
    this.sessions = new Map(); // sessionId -> { cwd, branch, project, lastSeen, messageCount }
    this.activeSession = null; // Most recently active session ID
  }

  track(sessionId, cwd, extra = {}) {
    const existing = this.sessions.get(sessionId) || { messageCount: 0 };
    this.sessions.set(sessionId, {
      cwd,
      project: path.basename(cwd),
      branch: extra.branch || "unknown",
      lastSeen: Date.now(),
      messageCount: existing.messageCount + 1,
      ...extra,
    });
    this.activeSession = sessionId;
  }

  getActive() {
    if (!this.activeSession) return null;
    const session = this.sessions.get(this.activeSession);
    if (!session) return null;
    return { id: this.activeSession, ...session };
  }

  setActive(sessionId) {
    if (this.sessions.has(sessionId)) {
      this.activeSession = sessionId;
      return true;
    }
    return false;
  }

  list() {
    return Array.from(this.sessions.entries())
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  clear() {
    this.sessions.clear();
    this.activeSession = null;
  }
}

// ─── Prompt Queue ────────────────────────────────────────
class PromptQueue {
  constructor(maxSize) {
    this.queue = [];
    this.processing = false;
    this.maxSize = maxSize;
    this.currentJob = null;
  }

  enqueue(job) {
    if (this.queue.length >= this.maxSize) {
      return { success: false, position: -1 };
    }
    this.queue.push(job);
    const position = this.queue.length;
    this.processNext();
    return { success: true, position };
  }

  async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    this.currentJob = this.queue.shift();
    try {
      await this.currentJob.execute();
    } catch (err) {
      console.error("Job error:", err.message);
      if (this.currentJob.onError) this.currentJob.onError(err);
    }
    this.currentJob = null;
    this.processing = false;
    this.processNext();
  }

  getStatus() {
    return {
      pending: this.queue.length,
      processing: this.processing,
      currentPrompt: this.currentJob?.prompt?.substring(0, 60) || null,
    };
  }

  clear() {
    this.queue = [];
  }
}

// ─── Security: Passphrase Lock ───────────────────────────
class SecurityLock {
  constructor(passphrase, autoLockMinutes) {
    this.passphrase = passphrase;
    this.unlocked = !passphrase; // If no passphrase, always unlocked
    this.lastActivity = Date.now();
    this.autoLockMs = autoLockMinutes * 60 * 1000;

    if (passphrase && autoLockMinutes > 0) {
      setInterval(() => this.checkAutoLock(), 60 * 1000);
    }
  }

  isUnlocked() {
    if (!this.passphrase) return true;
    if (!this.unlocked) return false;

    // Check auto-lock timeout
    if (this.autoLockMs > 0 && Date.now() - this.lastActivity > this.autoLockMs) {
      this.unlocked = false;
      return false;
    }
    return true;
  }

  tryUnlock(input) {
    if (input.trim() === this.passphrase) {
      this.unlocked = true;
      this.lastActivity = Date.now();
      return true;
    }
    return false;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  lock() {
    this.unlocked = false;
  }

  checkAutoLock() {
    if (this.unlocked && this.autoLockMs > 0 && Date.now() - this.lastActivity > this.autoLockMs) {
      this.unlocked = false;
      console.log("🔒 Auto-locked due to inactivity");
    }
  }
}

// ─── Claude Code Runner ──────────────────────────────────
function runClaudeResume(prompt, sessionId, cwd, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "json"];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    console.log(`▶ Running: claude ${args.join(" ")}`);
    console.log(`  cwd: ${cwd}`);

    const child = spawn("claude", args, {
      cwd: cwd,
      env: { ...process.env },
      timeout: timeoutSeconds * 1000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout);
          resolve({
            text:
              parsed.result ||
              (parsed.content || [])
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n") ||
              stdout,
            sessionId: parsed.session_id || sessionId,
            raw: parsed,
          });
        } catch {
          // Not JSON, return raw text
          resolve({ text: stdout.trim() || "(empty response)", sessionId, raw: null });
        }
      } else {
        reject(new Error(stderr || `Claude exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to run Claude Code: ${err.message}`));
    });
  });
}

// ─── Message Utilities ───────────────────────────────────
function splitMessage(text, maxLength = 1900) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength;
    }
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

// ─── Discord Bot ─────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

const sessions = new SessionTracker();
const queue = new PromptQueue(CONFIG.maxQueueSize);
const lock = new SecurityLock(CONFIG.passphrase, CONFIG.autoLockMinutes);

// ─── Authorization ───────────────────────────────────────
function isAuthorized(message) {
  if (message.author.bot) return false;
  if (message.author.id !== CONFIG.allowedUserId) return false;
  if (CONFIG.channelId && message.channel.id !== CONFIG.channelId) return false;
  return true;
}

// ─── Command Handlers ────────────────────────────────────
const COMMANDS = {
  "!help": cmdHelp,
  "!status": cmdStatus,
  "!sessions": cmdSessions,
  "!switch": cmdSwitch,
  "!clear": cmdClear,
  "!queue": cmdQueue,
  "!cancel": cmdCancel,
  "!lock": cmdLock,
  "!unlock": cmdUnlock,
};

async function cmdHelp(message) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🤖 Claude Code Remote — Help")
    .setDescription(
      "This bot lets you continue Claude Code sessions from your phone via Discord.\n\n" +
        "**How it works:**\n" +
        "Claude Code hooks send notifications here when tasks finish or need input. " +
        "Your replies are sent back to Claude Code using `--resume`.\n"
    )
    .addFields(
      {
        name: "Commands",
        value: [
          "`!help` — This help message",
          "`!status` — Current session, queue, and lock status",
          "`!sessions` — List all tracked sessions",
          "`!switch <id>` — Switch active session by ID prefix",
          "`!clear` — Clear all tracked sessions",
          "`!queue` — View pending jobs",
          "`!cancel` — Clear the job queue",
          "`!lock` — Lock the bot (requires passphrase to unlock)",
          "`!unlock` — Unlock with passphrase",
        ].join("\n"),
      },
      {
        name: "Usage",
        value:
          "Just type any message to send it to the active Claude Code session. " +
          "The bot will `--resume` the session with your input and return the response.",
      }
    );
  await message.reply({ embeds: [embed] });
}

async function cmdStatus(message) {
  const active = sessions.getActive();
  const queueStatus = queue.getStatus();

  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("📊 Status").addFields(
    {
      name: "Active Session",
      value: active
        ? `**${active.project}** (${active.branch})\n\`${active.id.substring(0, 12)}...\`\n📂 \`${active.cwd}\``
        : "None — waiting for Claude Code hooks to report a session",
      inline: false,
    },
    {
      name: "Queue",
      value: `${queueStatus.pending} pending | ${queueStatus.processing ? "⚙️ Processing" : "✅ Idle"}`,
      inline: true,
    },
    {
      name: "Security",
      value: lock.isUnlocked() ? "🔓 Unlocked" : "🔒 Locked",
      inline: true,
    }
  );

  if (queueStatus.currentPrompt) {
    embed.addFields({
      name: "Current Job",
      value: `\`${queueStatus.currentPrompt}...\``,
      inline: false,
    });
  }

  await message.reply({ embeds: [embed] });
}

async function cmdSessions(message) {
  const list = sessions.list();
  if (list.length === 0) {
    await message.reply("No sessions tracked yet. Start Claude Code with hooks enabled to see sessions here.");
    return;
  }

  const lines = list.map((s, i) => {
    const active = s.id === sessions.activeSession ? " ← active" : "";
    const age = Math.round((Date.now() - s.lastSeen) / 60000);
    return `**${i + 1}.** \`${s.id.substring(0, 12)}...\` — **${s.project}** (${s.branch}) — ${age}m ago${active}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("📋 Tracked Sessions")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Use !switch <id-prefix> to change active session" });

  await message.reply({ embeds: [embed] });
}

async function cmdSwitch(message) {
  const prefix = message.content.split(/\s+/)[1];
  if (!prefix) {
    await message.reply("Usage: `!switch <session-id-prefix>`\nUse `!sessions` to see available sessions.");
    return;
  }

  const match = sessions.list().find((s) => s.id.startsWith(prefix));
  if (!match) {
    await message.reply(`No session found starting with \`${prefix}\`. Use \`!sessions\` to list.`);
    return;
  }

  sessions.setActive(match.id);
  await message.reply(
    `✅ Switched to **${match.project}** (${match.branch})\nSession: \`${match.id.substring(0, 12)}...\`\nDirectory: \`${match.cwd}\``
  );
}

async function cmdClear(message) {
  sessions.clear();
  await message.reply("🧹 All sessions cleared.");
}

async function cmdQueue(message) {
  const status = queue.getStatus();
  await message.reply(
    status.processing
      ? `⚙️ Processing: \`${status.currentPrompt}...\`\n📋 ${status.pending} job(s) queued`
      : "✅ Queue is empty."
  );
}

async function cmdCancel(message) {
  queue.clear();
  await message.reply("🛑 Queue cleared.");
}

async function cmdLock(message) {
  if (!CONFIG.passphrase) {
    await message.reply("No passphrase configured. Set `BOT_PASSPHRASE` in .env to enable locking.");
    return;
  }
  lock.lock();
  await message.reply("🔒 Bot locked. Use `!unlock` with your passphrase to resume.");
}

async function cmdUnlock(message) {
  if (!CONFIG.passphrase) {
    await message.reply("No passphrase configured — bot is always unlocked.");
    return;
  }
  const phrase = message.content.replace(/^!unlock\s*/i, "").trim();
  if (lock.tryUnlock(phrase)) {
    // Delete the message containing the passphrase for security
    try {
      await message.delete();
    } catch {}
    await message.channel.send("🔓 Bot unlocked! You can now send prompts.");
  } else {
    await message.reply("❌ Wrong passphrase.");
  }
}

// ─── Webhook Listener (receives hook data) ───────────────
// The hooks send data via Discord webhook (embeds).
// The bot also needs to parse those webhook messages to track sessions.
// We do this by watching for embed messages from webhooks in the channel.

function parseSessionFromEmbed(embed) {
  if (!embed || !embed.fields) return null;

  let sessionId = null;
  let cwd = null;
  let branch = null;
  let project = null;

  for (const field of embed.fields) {
    if (field.name.includes("Session")) {
      // Extract session ID from backtick-wrapped text like `abc123def4...`
      const match = field.value.match(/`([^`]+)`/);
      if (match) sessionId = match[1].replace("...", "");
    }
    if (field.name.includes("Directory")) {
      const match = field.value.match(/`([^`]+)`/);
      if (match) cwd = match[1];
    }
    if (field.name.includes("Branch")) {
      const match = field.value.match(/`([^`]+)`/);
      if (match) branch = match[1];
    }
    if (field.name.includes("Project")) {
      const match = field.value.match(/`([^`]+)`/);
      if (match) project = match[1];
    }
  }

  // Try to find full session ID from resume command field
  for (const field of embed.fields) {
    if (field.name.includes("Resume")) {
      const match = field.value.match(/--resume\s+([a-f0-9-]+)/);
      if (match) sessionId = match[1];
    }
  }

  return sessionId && cwd ? { sessionId, cwd, branch, project } : null;
}

// ─── Main Message Handler ────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  // Track sessions from webhook embed messages
  if (message.author.bot && message.embeds.length > 0) {
    for (const embed of message.embeds) {
      const sessionInfo = parseSessionFromEmbed(embed);
      if (sessionInfo) {
        sessions.track(sessionInfo.sessionId, sessionInfo.cwd, {
          branch: sessionInfo.branch || "unknown",
        });
        console.log(`📍 Tracked session: ${sessionInfo.sessionId.substring(0, 12)}... → ${sessionInfo.cwd}`);
      }
    }
    return;
  }

  // Ignore other bots
  if (message.author.bot) return;

  // Auth check
  if (!isAuthorized(message)) return;

  const content = message.content.trim();
  if (!content) return;

  // Handle commands
  const cmd = content.toLowerCase().split(/\s+/)[0];
  if (COMMANDS[cmd]) {
    await COMMANDS[cmd](message);
    return;
  }

  // Handle unlock attempts
  if (!lock.isUnlocked()) {
    if (content.startsWith("!unlock")) {
      await cmdUnlock(message);
    } else {
      await message.reply("🔒 Bot is locked. Use `!unlock <passphrase>` to unlock.");
    }
    return;
  }

  // Touch security timer
  lock.touch();

  // It's a prompt — find active session
  const active = sessions.getActive();
  if (!active) {
    await message.reply(
      "⚠️ No active session. Start Claude Code with hooks enabled, and the bot will auto-detect sessions when Claude finishes a task.\n\n" +
        "Or send a fresh prompt without resume: the bot will start a new Claude Code session in your home directory."
    );
    return;
  }

  const prompt = content;
  const sessionId = active.id;
  const cwd = active.cwd;

  // Enqueue the job
  const result = queue.enqueue({
    prompt,
    execute: async () => {
      // Typing indicator
      await message.channel.sendTyping();
      const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8000);

      try {
        await message.react("⏳");

        const response = await runClaudeResume(prompt, sessionId, cwd, CONFIG.claudeTimeout);

        // Update session tracking
        if (response.sessionId) {
          sessions.track(response.sessionId, cwd, { branch: active.branch });
        }

        await message.reactions.cache.get("⏳")?.remove().catch(() => {});
        await message.react("✅");

        // Send response
        const chunks = splitMessage(response.text);
        for (let i = 0; i < chunks.length; i++) {
          const msg = chunks.length > 1 ? `${chunks[i]}\n\n_[${i + 1}/${chunks.length}]_` : chunks[i];
          if (i === 0) {
            await message.reply(msg);
          } else {
            await message.channel.send(msg);
          }
        }

        // Queue status
        const qs = queue.getStatus();
        if (qs.pending > 0) {
          await message.channel.send(`📋 _${qs.pending} job(s) remaining..._`);
        }
      } catch (error) {
        await message.reactions.cache.get("⏳")?.remove().catch(() => {});
        await message.react("❌");

        const errEmbed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("❌ Error")
          .setDescription(`\`\`\`${error.message.substring(0, 1000)}\`\`\``)
          .setFooter({ text: "Check that Claude Code is installed and the session directory exists" });
        await message.reply({ embeds: [errEmbed] });
      } finally {
        clearInterval(typingInterval);
      }
    },
    onError: async (err) => {
      await message.react("❌");
      await message.reply(`❌ ${err.message}`);
    },
  });

  if (result.success && result.position > 1) {
    await message.reply(`📋 Queued at position **${result.position}**. ${result.position - 1} ahead.`);
  } else if (!result.success) {
    await message.reply("⚠️ Queue is full. Wait for current jobs to finish.");
  }
});

// ─── Bot Ready ───────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║   🤖 Claude Code Remote Bot is LIVE!         ║");
  console.log("╠═══════════════════════════════════════════════╣");
  console.log(`║  Bot       : ${client.user.tag.padEnd(32)}║`);
  console.log(`║  User      : ${CONFIG.allowedUserId.padEnd(32)}║`);
  console.log(`║  Channel   : ${(CONFIG.channelId || "Any / DMs").padEnd(32)}║`);
  console.log(`║  Passphrase: ${(CONFIG.passphrase ? "Enabled" : "Disabled").padEnd(32)}║`);
  console.log(`║  Auto-lock : ${(CONFIG.autoLockMinutes ? CONFIG.autoLockMinutes + " min" : "Disabled").padEnd(32)}║`);
  console.log(`║  Queue     : ${(CONFIG.maxQueueSize + " max").padEnd(32)}║`);
  console.log("╠═══════════════════════════════════════════════╣");
  console.log("║  Waiting for Claude Code hooks to report...   ║");
  console.log("╚═══════════════════════════════════════════════╝");
});

// ─── Graceful Shutdown ───────────────────────────────────
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down...");
  client.destroy();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("\n🛑 Shutting down...");
  client.destroy();
  process.exit(0);
});

// ─── Start ───────────────────────────────────────────────
client.login(CONFIG.token);
