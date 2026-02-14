const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
} = require("discord.js");
const { spawn } = require("child_process");
const path = require("path");
require("dotenv").config();

// ─── Configuration ───────────────────────────────────────
const CONFIG = {
  token: process.env.DISCORD_BOT_TOKEN,
  allowedUserId: process.env.ALLOWED_USER_ID,
  channelId: process.env.NOTIFICATION_CHANNEL_ID || null,
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
class SessionTracker {
  constructor() {
    this.sessions = new Map();
    this.activeSession = null;
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

// ─── Security Lock ───────────────────────────────────────
class SecurityLock {
  constructor(passphrase, autoLockMinutes) {
    this.passphrase = passphrase;
    this.unlocked = !passphrase;
    this.lastActivity = Date.now();
    this.autoLockMs = autoLockMinutes * 60 * 1000;

    if (passphrase && autoLockMinutes > 0) {
      setInterval(() => this.checkAutoLock(), 60 * 1000);
    }
  }

  isUnlocked() {
    if (!this.passphrase) return true;
    if (!this.unlocked) return false;
    if (
      this.autoLockMs > 0 &&
      Date.now() - this.lastActivity > this.autoLockMs
    ) {
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
    if (
      this.unlocked &&
      this.autoLockMs > 0 &&
      Date.now() - this.lastActivity > this.autoLockMs
    ) {
      this.unlocked = false;
      console.log("🔒 Auto-locked due to inactivity");
    }
  }
}

// ─── Claude Code Runner ──────────────────────────────────
// Uses --continue instead of --resume because -p --resume has a confirmed bug
// (GitHub #1967). --continue picks up the most recent session in the given cwd.
function runClaudeContinue(prompt, cwd, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    // -c = --continue (most recent session in this directory)
    // -p = print/headless mode (non-interactive)
    const args = [
      "-c",
      "-p",
      `"${prompt}"`,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ];

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
      console.log(`◀ Claude exited with code: ${code}`);
      console.log(`  stdout length: ${stdout.length}`);
      console.log(`  stderr: ${stderr.substring(0, 200) || "(empty)"}`);

      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout);
          let text = "";
          if (parsed.result) {
            text = parsed.result;
          } else if (Array.isArray(parsed.content)) {
            text = parsed.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
          } else {
            text = stdout;
          }
          console.log(`  parsed result length: ${text.length}`);
          resolve({
            text: text || "(empty response)",
            sessionId: parsed.session_id || null,
            raw: parsed,
          });
        } catch (parseErr) {
          console.log(`  JSON parse error: ${parseErr.message}`);
          console.log(`  raw stdout (first 200): ${stdout.substring(0, 200)}`);
          resolve({
            text: stdout.trim() || "(empty response)",
            sessionId: null,
            raw: null,
          });
        }
      } else {
        console.log(`  FAILED stderr: ${stderr}`);
        reject(new Error(stderr || `Claude exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      console.log(`  spawn error: ${err.message}`);
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

// ─── Parse session info from webhook embeds ──────────────
function parseSessionFromEmbed(embed) {
  if (!embed || !embed.fields) return null;

  let sessionId = null;
  let cwd = null;
  let branch = null;
  let project = null;

  for (const field of embed.fields) {
    const name = field.name || "";
    const value = field.value || "";

    if (name.includes("Session")) {
      const match = value.match(/([a-f0-9-]{8,})/);
      if (match) sessionId = match[1];
    }
    if (name.includes("Directory")) {
      const match = value.match(/`([^`]+)`/);
      if (match) cwd = match[1];
    }
    if (name.includes("Branch")) {
      branch = value.replace(/`/g, "").trim();
    }
    if (name.includes("Project")) {
      project = value.replace(/`/g, "").trim();
    }
    // Also try to extract full session ID from Resume command
    if (name.includes("Resume")) {
      const resumeMatch = value.match(/--resume\s+([a-f0-9-]+)/);
      if (resumeMatch) sessionId = resumeMatch[1];
      // Also grab cwd from the cd command
      const cdMatch = value.match(/cd\s+([^\s&]+)/);
      if (cdMatch && !cwd) cwd = cdMatch[1];
    }
  }

  return sessionId && cwd ? { sessionId, cwd, branch, project } : null;
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
      "Continue Claude Code sessions from your phone via Discord.\n\n" +
        "**How it works:**\n" +
        "Hooks notify you here when Claude finishes. " +
        "Your replies run `claude -c -p` (continue mode) in the project directory.\n",
    )
    .addFields(
      {
        name: "Commands",
        value: [
          "`!help` — This help message",
          "`!status` — Current session & queue status",
          "`!sessions` — List all tracked sessions",
          "`!switch <id>` — Switch active session",
          "`!clear` — Clear all sessions",
          "`!queue` — View pending jobs",
          "`!cancel` — Clear job queue",
          "`!lock` / `!unlock` — Passphrase lock",
        ].join("\n"),
      },
      {
        name: "Usage",
        value:
          "Just type a message to send it to the active session's project directory using `claude -c -p`.",
      },
    );
  await message.reply({ embeds: [embed] });
}

async function cmdStatus(message) {
  const active = sessions.getActive();
  const qs = queue.getStatus();
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📊 Status")
    .addFields(
      {
        name: "Active Session",
        value: active
          ? `**${active.project}** (${active.branch})\nSession: \`${active.id.substring(0, 12)}...\`\nDir: \`${active.cwd}\``
          : "None — start Claude Code with hooks, and it'll appear here",
        inline: false,
      },
      {
        name: "Queue",
        value: `${qs.pending} pending | ${qs.processing ? "⚙️ Processing" : "✅ Idle"}`,
        inline: true,
      },
      {
        name: "Security",
        value: lock.isUnlocked() ? "🔓 Unlocked" : "🔒 Locked",
        inline: true,
      },
    );
  await message.reply({ embeds: [embed] });
}

async function cmdSessions(message) {
  const list = sessions.list();
  if (list.length === 0) {
    await message.reply(
      "No sessions tracked yet. Use Claude Code with hooks enabled.",
    );
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
    await message.reply("Usage: `!switch <session-id-prefix>`");
    return;
  }
  const match = sessions.list().find((s) => s.id.startsWith(prefix));
  if (!match) {
    await message.reply(`No session found starting with \`${prefix}\`.`);
    return;
  }
  sessions.setActive(match.id);
  await message.reply(
    `✅ Switched to **${match.project}** (${match.branch})\nDir: \`${match.cwd}\``,
  );
}

async function cmdClear(message) {
  sessions.clear();
  await message.reply("🧹 All sessions cleared.");
}

async function cmdQueue(message) {
  const s = queue.getStatus();
  await message.reply(
    s.processing
      ? `⚙️ Processing: \`${s.currentPrompt}...\`\n📋 ${s.pending} queued`
      : "✅ Queue is empty.",
  );
}

async function cmdCancel(message) {
  queue.clear();
  await message.reply("🛑 Queue cleared.");
}

async function cmdLock(message) {
  if (!CONFIG.passphrase) {
    await message.reply(
      "No passphrase configured. Set `BOT_PASSPHRASE` in .env.",
    );
    return;
  }
  lock.lock();
  await message.reply("🔒 Locked.");
}

async function cmdUnlock(message) {
  if (!CONFIG.passphrase) {
    await message.reply("No passphrase needed — bot is always unlocked.");
    return;
  }
  const phrase = message.content.replace(/^!unlock\s*/i, "").trim();
  if (lock.tryUnlock(phrase)) {
    try {
      await message.delete();
    } catch {}
    await message.channel.send("🔓 Unlocked!");
  } else {
    await message.reply("❌ Wrong passphrase.");
  }
}

// ─── Main Message Handler ────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  // Track sessions from webhook embed messages (sent by hooks)
  if (message.author.bot && message.embeds.length > 0) {
    for (const embed of message.embeds) {
      const info = parseSessionFromEmbed(embed);
      if (info) {
        sessions.track(info.sessionId, info.cwd, {
          branch: info.branch || "unknown",
        });
        console.log(
          `📍 Tracked: ${info.sessionId.substring(0, 12)}... → ${info.cwd}`,
        );
      }
    }
    return;
  }

  if (message.author.bot) return;
  if (!isAuthorized(message)) return;

  const content = message.content.trim();
  if (!content) return;

  // Commands
  const cmd = content.toLowerCase().split(/\s+/)[0];
  if (COMMANDS[cmd]) {
    await COMMANDS[cmd](message);
    return;
  }

  // Lock check
  if (!lock.isUnlocked()) {
    if (content.startsWith("!unlock")) {
      await cmdUnlock(message);
    } else {
      await message.reply("🔒 Locked. Use `!unlock <passphrase>`.");
    }
    return;
  }
  lock.touch();

  // Get active session
  const active = sessions.getActive();
  if (!active) {
    await message.reply(
      "⚠️ No active session. Start Claude Code with hooks enabled — " +
        "the bot will auto-detect sessions when Claude finishes a task.",
    );
    return;
  }

  const prompt = content;
  const cwd = active.cwd;

  const result = queue.enqueue({
    prompt,
    execute: async () => {
      await message.channel.sendTyping();
      const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8000);

      try {
        await message.react("⏳");

        const response = await runClaudeContinue(
          prompt,
          cwd,
          CONFIG.claudeTimeout,
        );
        console.log(
          `✅ Got response, text length: ${response.text.length}, sessionId: ${response.sessionId}`,
        );

        // Update session if we got a new session ID back
        if (response.sessionId) {
          sessions.track(response.sessionId, cwd, { branch: active.branch });
        }

        await message.reactions.cache
          .get("⏳")
          ?.remove()
          .catch(() => {});
        await message.react("✅");

        const chunks = splitMessage(response.text);
        for (let i = 0; i < chunks.length; i++) {
          const msg =
            chunks.length > 1
              ? `${chunks[i]}\n\n_[${i + 1}/${chunks.length}]_`
              : chunks[i];
          if (i === 0) {
            await message.reply(msg);
          } else {
            await message.channel.send(msg);
          }
        }
      } catch (error) {
        console.log(`❌ Error in execute: ${error.message}`);
        await message.reactions.cache
          .get("⏳")
          ?.remove()
          .catch(() => {});
        await message.react("❌");

        const errEmbed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("❌ Error")
          .setDescription(`\`\`\`${error.message.substring(0, 1000)}\`\`\``)
          .setFooter({
            text: "Check Claude Code is installed and project directory exists",
          });
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
    await message.reply(`📋 Queued at position **${result.position}**.`);
  } else if (!result.success) {
    await message.reply("⚠️ Queue full. Wait for current jobs to finish.");
  }
});

// ─── Bot Ready ───────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║   🤖 Claude Code Remote Bot is LIVE!         ║");
  console.log("╠═══════════════════════════════════════════════╣");
  console.log(`║  Bot       : ${client.user.tag.padEnd(32)}║`);
  console.log(`║  User      : ${CONFIG.allowedUserId.padEnd(32)}║`);
  console.log(
    `║  Channel   : ${(CONFIG.channelId || "Any / DMs").padEnd(32)}║`,
  );
  console.log(
    `║  Passphrase: ${(CONFIG.passphrase ? "Enabled" : "Disabled").padEnd(32)}║`,
  );
  console.log(`║  Mode      : ${"claude -c -p (continue)".padEnd(32)}║`);
  console.log("╠═══════════════════════════════════════════════╣");
  console.log("║  Waiting for hooks to report sessions...      ║");
  console.log("╚═══════════════════════════════════════════════╝");
});

process.on("SIGINT", () => {
  client.destroy();
  process.exit(0);
});
process.on("SIGTERM", () => {
  client.destroy();
  process.exit(0);
});

client.login(CONFIG.token);
