// server.js — versione completa con log e broadcast dello stato
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const cors = require("cors");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
const LOG_DIR = path.join(__dirname, "logs");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const AUCTION_JSONL = path.join(LOG_DIR, "auction.jsonl");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error("Errore lettura JSON:", file, e.message);
    return fallback;
  }
}
function writeJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("Errore scrittura JSON:", file, e.message);
  }
}
function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

// Caricamento file
const usersArray = readJson(USERS_FILE, []);
const playersArray = readJson(PLAYERS_FILE, []);
const USERS_BY_IP = {};
for (const u of usersArray) {
  if (u && u.ip) USERS_BY_IP[u.ip] = {
    name: u.name,
    credits: Number(u.credits || 0),
    role: u.role === "admin" ? "admin" : "user"
  };
}
const INITIAL_PLAYERS = playersArray.map(p => ({
  id: String(p.id),
  name: p.name,
  team: p.team || "",
  base: Number(p.base || 1),
}));

console.log("[DEBUG] users.json caricato:", USERS_BY_IP);
console.log("[DEBUG] players.json caricato:", INITIAL_PLAYERS.map(p => p.id+":"+p.name));

// Stato
const defaultState = {
  users: {},
  players: {},
  auctionSettings: { startAt: null, endAt: null, extendOnBidSeconds: 0 },
};
for (const [ip, info] of Object.entries(USERS_BY_IP)) defaultState.users[ip] = { ...info };
for (const p of INITIAL_PLAYERS) {
  defaultState.players[p.id] = {
    id: p.id, name: p.name, team: p.team,
    currentBid: p.base, currentBidderIp: null, history: [], endAt: null, closed: false
  };
}
const state = readJson(STATE_FILE, defaultState);
console.log("[DEBUG] Stato iniziale utenti:", Object.keys(state.users));
console.log("[DEBUG] Stato iniziale giocatori:", Object.keys(state.players));

// App + Socket
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

function extractIp(socket) {
  const url = new URL(socket.handshake.url, "http://x");
  const forcedIp = url.searchParams.get("ip");
  if (forcedIp) return forcedIp;
  const xff = socket.handshake.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  const raw = socket.handshake.address || socket.request.connection?.remoteAddress;
  return (raw || "0.0.0.0").replace("::ffff:", "");
}

function committedCreditsFor(ip) {
  let sum = 0;
  for (const p of Object.values(state.players)) {
    if (p.currentBidderIp === ip && !p.closed) sum += Number(p.currentBid || 0);
  }
  return sum;
}
function remainingCredits(ip) {
  const u = state.users[ip];
  if (!u) return 0;
  return u.credits - committedCreditsFor(ip);
}

function broadcastState() {
  io.emit("state", {
    now: Date.now(),
    settings: state.auctionSettings,
    users: Object.fromEntries(
      Object.entries(state.users).map(([ip, u]) => [
        ip,
        { name: u.name, credits: u.credits, role: u.role, remaining: remainingCredits(ip) },
      ])
    ),
    players: state.players,
  });
}
function saveState(){ writeJson(STATE_FILE, state); }

// Logging offerta
function slugify(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,""); }
function playerJsonlPath(player){ return path.join(LOG_DIR, `${player.id}-${slugify(player.name||"player")}.jsonl`); }
function appendCsvLine(filePath, headers, values) {
  const exists = fs.existsSync(filePath);
  const esc = (v) => {
    const str = String(v ?? "");
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const line = values.map(esc).join(",") + "\n";
  if (!exists) fs.appendFileSync(filePath, headers.join(",") + "\n");
  fs.appendFileSync(filePath, line);
}
function playerCsvPath(player){ return path.join(LOG_DIR, `${player.id}-${slugify(player.name||"player")}.csv`); }
function logBidToFiles(player, entry) {
  appendCsvLine(playerCsvPath(player),
    ["ts_iso","ts_epoch","player_id","player_name","player_team","bidder_ip","bidder_name","amount"],
    [new Date(entry.ts).toISOString(), entry.ts, player.id, player.name, player.team||"", entry.ip, entry.name, entry.amount]);
  appendJsonl(playerJsonlPath(player), {
    event:"bid", ts:entry.ts, ts_iso:new Date(entry.ts).toISOString(),
    player_id: player.id, player_name: player.name, player_team: player.team||"",
    bidder_ip: entry.ip, bidder_name: entry.name, amount: entry.amount, currentBid: player.currentBid
  });
}

// Socket handlers
io.on("connection", (socket) => {
  const ip = extractIp(socket);
  console.log("[DEBUG] Nuova connessione:", {
    rawAddress: socket.handshake.address,
    xForwardedFor: socket.handshake.headers["x-forwarded-for"],
    query: socket.handshake.url,
    extractedIp: ip
  });

  const user = state.users[ip];
  console.log("[DEBUG] Utente riconosciuto?", !!user, "IP:", ip, "Dettagli:", user);

  // invia saluto e stato completo (per far comparire UI + cards)
  socket.emit("hello", {
    ip,
    recognized: !!user,
    name: user?.name,
    credits: user?.credits ?? 0,
    remaining: user ? remainingCredits(ip) : 0,
    isAdmin: user?.role === "admin"
  });
  socket.emit("state", {
    now: Date.now(),
    settings: state.auctionSettings,
    users: Object.fromEntries(
      Object.entries(state.users).map(([uip, u]) => [
        uip,
        { name: u.name, credits: u.credits, role: u.role, remaining: remainingCredits(uip) },
      ])
    ),
    players: state.players,
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Asta fantacalcio live su http://localhost:${PORT}`);
});
