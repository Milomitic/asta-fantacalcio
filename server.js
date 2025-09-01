// server.js — blocchi rilanci (asta non aperta / terminata), feedback & timers
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

// Load
const usersArray = readJson(USERS_FILE, []);
const playersArray = readJson(PLAYERS_FILE, []);
const USERS_BY_IP = {};
for (const u of usersArray) {
	if (u && u.ip)
		USERS_BY_IP[u.ip] = {
			name: u.name,
			credits: Number(u.credits || 0),
			role: u.role === "admin" ? "admin" : "user",
		};
}
const INITIAL_PLAYERS = playersArray.map((p) => ({
	id: String(p.id),
	name: p.name,
	team: p.team || "",
	base: Number(p.base || 1),
}));

// State
const defaultState = {
	users: {},
	players: {},
	auctionSettings: { startAt: null, endAt: null, extendOnBidSeconds: 0 },
};
for (const [ip, info] of Object.entries(USERS_BY_IP))
	defaultState.users[ip] = { ...info };
for (const p of INITIAL_PLAYERS) {
	defaultState.players[p.id] = {
		id: p.id,
		name: p.name,
		team: p.team,
		currentBid: p.base,
		currentBidderIp: null,
		history: [],
		endAt: null,
		closed: false,
		extendOnBidSeconds: null, // override per-card opzionale
	};
}
const state = readJson(STATE_FILE, defaultState);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// Helpers
function extractIp(socket) {
	const url = new URL(socket.handshake.url, "http://x");
	const forcedIp = url.searchParams.get("ip");
	if (forcedIp) return forcedIp;
	const xff = socket.handshake.headers["x-forwarded-for"];
	if (xff) return xff.split(",")[0].trim();
	const raw =
		socket.handshake.address || socket.request.connection?.remoteAddress;
	return (raw || "0.0.0.0").replace("::ffff:", "");
}
function committedCreditsFor(ip) {
	let sum = 0;
	for (const p of Object.values(state.players)) {
		if (p.currentBidderIp === ip && !p.closed)
			sum += Number(p.currentBid || 0);
	}
	return sum;
}
function remainingCredits(ip) {
	const u = state.users[ip];
	if (!u) return 0;
	return u.credits - committedCreditsFor(ip);
}
function effectiveExtendSeconds(player) {
	if (player.extendOnBidSeconds != null)
		return Number(player.extendOnBidSeconds) || 0;
	return Number(state.auctionSettings.extendOnBidSeconds) || 0;
}
function broadcastState() {
	io.emit("state", {
		now: Date.now(),
		settings: state.auctionSettings,
		users: Object.fromEntries(
			Object.entries(state.users).map(([ip, u]) => [
				ip,
				{
					name: u.name,
					credits: u.credits,
					role: u.role,
					remaining: remainingCredits(ip),
				},
			])
		),
		players: state.players,
	});
}
function saveState() {
	writeJson(STATE_FILE, state);
}

// Logging file per giocatore
function slugify(s) {
	return String(s)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
}
function playerJsonlPath(player) {
	return path.join(
		LOG_DIR,
		`${player.id}-${slugify(player.name || "player")}.jsonl`
	);
}
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
function playerCsvPath(player) {
	return path.join(
		LOG_DIR,
		`${player.id}-${slugify(player.name || "player")}.csv`
	);
}
function logBidToFiles(player, entry) {
	appendCsvLine(
		playerCsvPath(player),
		[
			"ts_iso",
			"ts_epoch",
			"player_id",
			"player_name",
			"player_team",
			"bidder_ip",
			"bidder_name",
			"amount",
		],
		[
			new Date(entry.ts).toISOString(),
			entry.ts,
			player.id,
			player.name,
			player.team || "",
			entry.ip,
			entry.name,
			entry.amount,
		]
	);
	appendJsonl(playerJsonlPath(player), {
		event: "bid",
		ts: entry.ts,
		ts_iso: new Date(entry.ts).toISOString(),
		player_id: player.id,
		player_name: player.name,
		player_team: player.team || "",
		bidder_ip: entry.ip,
		bidder_name: entry.name,
		amount: entry.amount,
		currentBid: player.currentBid,
	});
}

// SOCKET
io.on("connection", (socket) => {
	const ip = extractIp(socket);
	const user = state.users[ip];

	// initial payload
	socket.emit("hello", {
		ip,
		recognized: !!user,
		name: user?.name,
		credits: user?.credits ?? 0,
		remaining: user ? remainingCredits(ip) : 0,
		isAdmin: user?.role === "admin",
	});
	broadcastState();

	// BID — blocchi aggiuntivi richiesti
	socket.on("bid", ({ playerId, amount }) => {
		const bidderIp = extractIp(socket);
		const bidder = state.users[bidderIp];
		const p = state.players[playerId];
		const value = Number(amount);
		const now = Date.now();
		const { startAt } = state.auctionSettings;

		if (!bidder)
			return socket.emit(
				"error-msg",
				"Non sei riconosciuto: IP non mappato."
			);
		if (!p) return socket.emit("error-msg", "Giocatore inesistente.");
		if (!Number.isFinite(value) || value <= 0)
			return socket.emit("error-msg", "Importo non valido.");

		// 🔒 ASTA ANCORA CHIUSA: serve un startAt globale impostato e non nel futuro
		if (!startAt)
			return socket.emit(
				"error-msg",
				"Aste ancora chiuse: imposta l’orario di inizio."
			);
		if (now < startAt)
			return socket.emit("error-msg", "Asta non ancora iniziata.");

		// 🔒 ASTA CHIUSA (per-card o globale)
		if (p.closed || (p.endAt && now >= p.endAt)) {
			p.closed = true;
			return socket.emit(
				"error-msg",
				"Asta per questo giocatore terminata."
			);
		}

		if (p.currentBidderIp === bidderIp)
			return socket.emit("error-msg", "Sei già l’ultimo offerente.");
		if (value <= p.currentBid)
			return socket.emit(
				"error-msg",
				`L'offerta deve essere maggiore di ${p.currentBid}.`
			);
		const rem = remainingCredits(bidderIp);
		if (value > rem)
			return socket.emit(
				"error-msg",
				`Offerta superiore ai crediti residui (${rem}).`
			);

		// apply
		p.currentBid = value;
		p.currentBidderIp = bidderIp;
		const entry = { ts: now, ip: bidderIp, name: bidder.name, amount: value };
		p.history.push(entry);

		// timer handling
		const ext = effectiveExtendSeconds(p);
		if (ext > 0) p.endAt = now + ext * 1000;

		try {
			logBidToFiles(p, entry);
		} catch (e) {
			console.error("Log bid error:", e.message);
		}

		saveState();

		// feedback
		socket.emit("bid:ok", {
			playerId: p.id,
			playerName: p.name,
			amount: value,
			yourRemaining: remainingCredits(bidderIp),
		});
		io.emit("event:bid", {
			playerId: p.id,
			playerName: p.name,
			amount: value,
			bidderIp,
			bidderName: bidder.name,
			ts: now,
		});

		broadcastState();
	});

	// ADMIN: global times
	socket.on(
		"admin:setTimes",
		({ startAtISO, endAtISO, extendOnBidSeconds }) => {
			const adminIp = extractIp(socket);
			if (state.users[adminIp]?.role !== "admin")
				return socket.emit("error-msg", "Permesso negato (solo Admin).");

			const start = startAtISO ? Date.parse(startAtISO) : null;
			const end = endAtISO ? Date.parse(endAtISO) : null;
			const ext = Number(extendOnBidSeconds || 0);

			if (start && end && end <= start)
				return socket.emit(
					"error-msg",
					"La fine deve essere successiva all’inizio."
				);
			if (!Number.isFinite(ext) || ext < 0)
				return socket.emit("error-msg", "Timer di rilancio non valido.");

			state.auctionSettings.startAt = start;
			state.auctionSettings.endAt = ext > 0 ? null : end;
			state.auctionSettings.extendOnBidSeconds = ext;

			// non sovrascrivere override per-card
			if (ext === 0) {
				for (const p of Object.values(state.players)) {
					if (
						!p.closed &&
						(p.extendOnBidSeconds == null || p.extendOnBidSeconds === 0)
					) {
						p.endAt = end || null;
					}
				}
			}

			saveState();
			socket.emit("admin:ok", {
				scope: "global",
				start,
				end: state.auctionSettings.endAt,
				extendOnBidSeconds: ext,
			});
			broadcastState();
		}
	);

	// ADMIN: per-player times
	socket.on(
		"admin:setPlayerTimes",
		({ playerId, endAtISO, extendOnBidSeconds }) => {
			const adminIp = extractIp(socket);
			if (state.users[adminIp]?.role !== "admin")
				return socket.emit("error-msg", "Permesso negato (solo Admin).");

			const p = state.players[playerId];
			if (!p) return socket.emit("error-msg", "Giocatore inesistente.");

			const end = endAtISO ? Date.parse(endAtISO) : null;
			const ext =
				extendOnBidSeconds === "" || extendOnBidSeconds == null
					? null
					: Number(extendOnBidSeconds);
			if (ext != null && (!Number.isFinite(ext) || ext < 0))
				return socket.emit("error-msg", "Timer per-rilancio non valido.");

			p.endAt = end;
			p.extendOnBidSeconds = ext;

			saveState();
			socket.emit("admin:ok", {
				scope: "player",
				playerId: p.id,
				endAt: p.endAt,
				extendOnBidSeconds: p.extendOnBidSeconds,
			});
			broadcastState();
		}
	);
});

// auto-close loop
setInterval(() => {
	const now = Date.now();
	let changed = false;
	for (const p of Object.values(state.players)) {
		if (!p.closed && p.endAt && now >= p.endAt) {
			p.closed = true;
			changed = true;
			appendJsonl(AUCTION_JSONL, {
				event: "close",
				ts: now,
				ts_iso: new Date(now).toISOString(),
				player_id: p.id,
				player_name: p.name,
				winner_ip: p.currentBidderIp || null,
				final_amount: p.currentBid,
			});
		}
	}
	if (changed) {
		writeJson(STATE_FILE, state);
		broadcastState();
	}
}, 1000);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
	console.log(`Asta fantacalcio live su http://localhost:${PORT}`);
});
