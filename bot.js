import { io } from "socket.io-client";
import readline from "readline";
import fetch from "node-fetch";
import fs from "fs";

// ── Config ──────────────────────────────────────────────────────────
const SERVER_URL = "https://classic.talkomatic.co";
const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const OLLAMA_MODEL = "qwen3.5:4b"; // change to gemma3:4b, qwen3:1.7b, etc.
const USERNAME = "Gemma";
const LOCATION = "msg me @gemma";
const USER_LIST_FILE = "./user_list.json";
const TOKEN_FILE = ".bot_token";
const COOLDOWN_MS = 5000;

// ── Readline helper ─────────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const prompt = (q) => new Promise((res) => rl.question(q, res));

// ── State ───────────────────────────────────────────────────────────
let myUserId = null;
const userMessages = new Map(); // userId → current text buffer
const roomUsers = {}; // userId → { username, location }
const cooldowns = {}; // userId → next-allowed timestamp
let responseLog = new Map(); // userId → { user, question, answer }

// ── Ensure user_list.json exists ────────────────────────────────────
if (!fs.existsSync(USER_LIST_FILE)) fs.writeFileSync(USER_LIST_FILE, "[]");

// ── Token helper (auto-generates & persists if missing) ─────────────
// Priority: hardcoded → .bot_token file → env var → auto-request new one
const HARDCODED_TOKEN = ""; // paste your token here if you want, e.g. "tk_abc123..."

async function ensureToken() {
  // 1. Hardcoded
  if (HARDCODED_TOKEN) {
    console.log("Using hardcoded bot token.");
    return HARDCODED_TOKEN;
  }

  // 2. Saved in .bot_token file from a previous run
  if (fs.existsSync(TOKEN_FILE)) {
    const saved = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) {
      console.log(`Using saved bot token from ${TOKEN_FILE}`);
      return saved;
    }
  }

  // 3. Environment variable
  if (process.env.BOT_TOKEN) {
    console.log("Using BOT_TOKEN from environment.");
    return process.env.BOT_TOKEN;
  }

  // 4. Auto-request a new one and save it
  console.log("No token found — requesting a new one...");
  const res = await fetch(`${SERVER_URL}/api/v1/bot-tokens/request`, {
    method: "POST",
  });
  if (!res.ok)
    throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const { token, expiresAt } = await res.json();
  console.log(`Got new token: ${token}`);
  console.log(`Expires: ${expiresAt}`);

  // Save to file so we reuse it next run
  fs.writeFileSync(TOKEN_FILE, token);
  console.log(
    `Saved token to ${TOKEN_FILE} (reused automatically on next run)`,
  );
  return token;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const roomId = await prompt("Enter room ID: ");
  const token = await ensureToken();

  // ── Connect ─────────────────────────────────────────────────────
  const socket = io(SERVER_URL, {
    auth: { token },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 3000,
  });

  // ── Helpers ─────────────────────────────────────────────────────

  /** Build the bot's text buffer showing the Q&A log */
  function buildResponseDisplay(statusLine) {
    let lines = [];

    // Show past Q&A pairs
    for (const entry of responseLog.values()) {
      lines.push(`💬 ${entry.user}: ${entry.question}`);
      lines.push(`→ ${entry.answer}`);
      lines.push("─".repeat(30));
    }

    // Show a status line (e.g. "loading..." for a pending request)
    if (statusLine) lines.push(statusLine);

    return lines.join("\n");
  }

  /** Send (or overwrite) the bot's text buffer */
  function sendMessage(text) {
    socket.emit("chat update", {
      diff: { type: "full-replace", text: text.slice(0, 15000) },
    });
  }

  /** Apply an incoming diff to a tracked user buffer */
  function applyDiff(userId, diff) {
    let msg = userMessages.get(userId) || "";
    if (diff.type === "full-replace") msg = diff.text;
    else if (diff.type === "add")
      msg = msg.slice(0, diff.index) + diff.text + msg.slice(diff.index);
    else if (diff.type === "delete")
      msg = msg.slice(0, diff.index) + msg.slice(diff.index + diff.count);
    else if (diff.type === "replace")
      msg =
        msg.slice(0, diff.index) +
        diff.text +
        msg.slice(diff.index + diff.text.length);
    userMessages.set(userId, msg);
    return msg;
  }

  /** Persist the running user list to disk */
  function updateUserList() {
    try {
      let list = [];
      try {
        list = JSON.parse(fs.readFileSync(USER_LIST_FILE, "utf8"));
      } catch {}
      if (!Array.isArray(list)) list = [];

      for (const [id, u] of Object.entries(roomUsers)) {
        const existing = list.find((x) => x.id === id);
        if (existing) {
          existing.username = u.username;
          existing.location = u.location;
        } else list.push({ id, username: u.username, location: u.location });
      }
      fs.writeFileSync(USER_LIST_FILE, JSON.stringify(list, null, 2));
    } catch (err) {
      console.error("Error updating user list:", err);
    }
  }

  /** Call the local Ollama chat endpoint */
  async function generateResponse(message) {
    try {
      const res = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [
            {
              role: "system",
              content:
                "You are a helpful chatbot in a real-time chat room called Talkomatic. Keep responses concise (under 500 chars) since this is a live chat. Be friendly and conversational.",
            },
            { role: "user", content: message },
          ],
          stream: false,
        }),
      });
      const body = await res.json();
      return body.message?.content || "No response.";
    } catch (err) {
      console.error("Ollama error:", err);
      return "Sorry, I couldn't process your message. Is Ollama running? (ollama serve)";
    }
  }

  /** Process a completed message for commands / AI trigger */
  function handleMessage(userId, text) {
    const msg = text.trim();

    // ── Lore of the Day ───────────────────────────────────────────
    if (msg === "!LOTD") {
      try {
        const lore = JSON.parse(fs.readFileSync("lore.json", "utf8"));
        sendMessage(`**Lore of the Day**: ${lore.daily}`);
      } catch {
        sendMessage("Lore file not found.");
      }
      return;
    }

    // ── List users ────────────────────────────────────────────────
    if (msg === "!listusers") {
      try {
        const list = JSON.parse(fs.readFileSync(USER_LIST_FILE, "utf8"));
        const names = list
          .map((u) => `${u.username} / ${u.location}`)
          .join("\n");
        sendMessage(`User list (${list.length} users):\n${names}`);
      } catch {
        sendMessage("Error retrieving user list.");
      }
      return;
    }

    // ── Search user ───────────────────────────────────────────────
    if (msg.startsWith("!searchuser")) {
      const query = msg.split(" ").slice(1).join(" ").trim();
      if (!query) {
        sendMessage("Usage: !searchuser <name>");
        return;
      }
      try {
        const list = JSON.parse(fs.readFileSync(USER_LIST_FILE, "utf8"));
        const hits = list.filter((u) =>
          u.username?.toLowerCase().includes(query.toLowerCase()),
        );
        if (hits.length === 0) sendMessage(`No users matching "${query}"`);
        else
          sendMessage(
            `Found ${hits.length} user(s):\n${hits.map((u) => `${u.username} / ${u.location}`).join("\n")}`,
          );
      } catch {
        sendMessage("User list file not found.");
      }
      return;
    }

    // ── Commands list ─────────────────────────────────────────────
    if (msg === "!commands") {
      sendMessage(
        "**Commands:**\n" +
          "!commands        — Show this list\n" +
          "!listusers       — List all known users\n" +
          "!searchuser <q>  — Search users by name\n" +
          "!LOTD            — Lore of the Day\n" +
          "@gemma           — End message with @gemma to ask AI",
      );
      return;
    }

    // ── AI trigger (@gemma at end) ──────────────────────────────
    if (msg.toLowerCase().endsWith("@gemma")) {
      const cleanMsg = msg.slice(0, msg.lastIndexOf("@")).trim(); // strip @gemma
      const now = Date.now();
      if (cooldowns[userId] && cooldowns[userId] > now) {
        sendMessage(buildResponseDisplay("⏳ Please wait a moment...", null));
        return;
      }
      cooldowns[userId] = now + COOLDOWN_MS;

      // Look up the asking user's name
      const asker = roomUsers[userId]?.username || "Someone";
      sendMessage(
        buildResponseDisplay(`⏳ ${asker} asked: "${cleanMsg}"`, null),
      );

      generateResponse(cleanMsg).then((resp) => {
        // Update (or add) this user's entry — one per user
        responseLog.set(userId, {
          user: asker,
          question: cleanMsg,
          answer: resp,
        });
        // Cap at 5 users to avoid hitting 15k buffer
        if (responseLog.size > 5) {
          const oldest = responseLog.keys().next().value;
          responseLog.delete(oldest);
        }
        sendMessage(buildResponseDisplay(null, null));
      });
    }
  }

  // ── Socket events ───────────────────────────────────────────────

  socket.on("connect", () => {
    console.log("Connected — signing in...");
    socket.emit("join lobby", { username: USERNAME, location: LOCATION });
  });

  socket.on("signin status", (data) => {
    if (!data.isSignedIn) {
      console.error("Sign-in failed:", data);
      return;
    }
    myUserId = data.userId;
    console.log(`Signed in as ${data.username} (${myUserId})`);
    console.log(`Joining room ${roomId}...`);
    socket.emit("join room", { roomId });
  });

  socket.on("room joined", (data) => {
    console.log(`Joined room: ${data.roomName} (${data.roomId})`);

    // Seed user list & message buffers from room state
    if (data.users) {
      for (const u of data.users) {
        roomUsers[u.id] = { username: u.username, location: u.location };
      }
      updateUserList();
    }
    if (data.currentMessages) {
      for (const [uid, txt] of Object.entries(data.currentMessages)) {
        userMessages.set(uid, txt);
      }
    }
  });

  // ── Track other users' text buffers & detect completed messages ─
  // NOTE: Talkomatic is real-time character-by-character. There is no
  // discrete "message sent" event — text just changes. We detect a
  // "command" whenever the buffer settles into a recognized pattern.
  // A simple approach: check on every diff. Debouncing can be added later.
  const handled = new Map(); // userId → last text we already handled

  socket.on("chat update", (data) => {
    if (data.userId === myUserId) return; // ignore own echoes
    const fullText = applyDiff(data.userId, data.diff);

    // Only trigger once per distinct message
    if (handled.get(data.userId) === fullText) return;

    // Check if the text looks "done" — ends with a command marker
    const trimmed = fullText.trim();
    const isCommand =
      trimmed === "!LOTD" ||
      trimmed === "!listusers" ||
      trimmed === "!commands" ||
      trimmed.startsWith("!searchuser") ||
      trimmed.toLowerCase().endsWith("@gemma");

    if (isCommand) {
      handled.set(data.userId, fullText);
      handleMessage(data.userId, fullText);
    }
  });

  // ── User join / leave ───────────────────────────────────────────
  socket.on("user joined", (data) => {
    console.log(`+ ${data.username} joined`);
    roomUsers[data.id] = { username: data.username, location: data.location };
    updateUserList();
  });

  socket.on("user left", (userId) => {
    console.log(`- ${roomUsers[userId]?.username || userId} left`);
    userMessages.delete(userId);
    handled.delete(userId);
    delete roomUsers[userId];
  });

  socket.on("room update", (data) => {
    if (data.users) {
      for (const u of data.users) {
        roomUsers[u.id] = { username: u.username, location: u.location };
      }
      updateUserList();
    }
  });

  // ── AFK prevention (critical — server kicks after 3 min idle) ──
  socket.on("afk warning", () => {
    console.log("AFK warning received — responding");
    socket.emit("afk response");
  });

  socket.on("afk timeout", (data) => {
    console.log("Kicked for AFK:", data?.message);
  });

  // ── Kicked by vote ─────────────────────────────────────────────
  socket.on("kicked", () => {
    console.log("Kicked from room by vote.");
  });

  // ── Error handling ─────────────────────────────────────────────
  socket.on("error", (data) => console.error("Server error:", data));
  socket.on("validation_error", (data) =>
    console.error("Validation error:", data),
  );
  socket.on("connect_error", (err) =>
    console.error("Connection error:", err.message),
  );
  socket.on("disconnect", (reason) => console.log("Disconnected:", reason));

  socket.on("room not found", () => console.error("Room not found"));
  socket.on("room full", () => console.error("Room is full"));
  socket.on("access code required", () =>
    console.error("Access code required"),
  );

  // ── Graceful shutdown ──────────────────────────────────────────
  const shutdown = () => {
    console.log("\nShutting down...");
    socket.emit("leave room");
    socket.disconnect();
    rl.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
