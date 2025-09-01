// server.js con log IP e stato utenti/giocatori per debug

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

const usersArray = readJson(USERS_FILE, []);
const playersArray = readJson(PLAYERS_FILE, []);
const USERS_BY_IP = {};
for (const u of usersArray) {
  if (u && u.ip) USERS_BY_IP[u.ip] = { name: u.name, credits: u.credits, role: u.role };
}
const INITIAL_PLAYERS = playersArray.map(p => ({ id: String(p.id), name: p.name, team: p.team || "", base: p.base }));

console.log("[DEBUG] users.json caricato:", USERS_BY_IP);
console.log("[DEBUG] players.json caricato:", INITIAL_PLAYERS);

const defaultState = { users: {}, players: {}, auctionSettings: { startAt: null, endAt: null, extendOnBidSeconds: 0 } };
for (const [ip, info] of Object.entries(USERS_BY_IP)) defaultState.users[ip] = { ...info };
for (const p of INITIAL_PLAYERS) {
  defaultState.players[p.id] = { id: p.id, name: p.name, team: p.team, currentBid: p.base, currentBidderIp: null, history: [], endAt: null, closed: false };
}
const state = readJson(STATE_FILE, defaultState);

console.log("[DEBUG] Stato iniziale utenti:", Object.keys(state.users));
console.log("[DEBUG] Stato iniziale giocatori:", Object.keys(state.players));

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

  socket.emit("hello", { ip, recognized: !!user, user });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Asta fantacalcio live (debug state) su http://localhost:${PORT}`);
});
