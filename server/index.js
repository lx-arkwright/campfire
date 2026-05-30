import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { Server } from "socket.io";

import { sanitize } from "../shared/filter.js";
import {
  MAX_PER_ROOM,
  findOpenRoom,
  joinRoom,
  leaveRoom,
  getRoom,
  occupants,
  registerVote,
  stats,
} from "./rooms.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";
// The public origin allowed to connect in production. Override via env if the
// domain changes; defaults to the campfire subdomain.
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "https://campfire.arkwright.work";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // No message logging, ever. Keep payloads small.
  maxHttpBufferSize: 4096,
  // Lock the handshake to a known origin. In dev the Vite client is served from
  // :5173 but connects to this server on :3000 (cross-origin); in prod the
  // server serves the built client from its own origin. We set it explicitly in
  // both cases — leaving CORS unset lets Socket.io reflect any origin.
  cors: {
    origin: isProd ? PUBLIC_ORIGIN : "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

// Strict CSP — the app loads ZERO third-party resources, so everything is
// 'self' (plus data: for the inline SVG favicon). Even if a future code change
// introduced an HTML-injection sink, the browser would still refuse to execute
// injected scripts. Doubles as a demonstrable "no third-party anything" proof.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'self'", // same-origin Socket.io (ws/wss) in production
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

// In production the server also serves the built client. In dev, Vite does
// (and a strict CSP would fight Vite's inline HMR styles, so prod-only).
if (isProd) {
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  const dist = join(__dirname, "..", "client", "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(join(dist, "index.html")));
}

// Track which room each socket is at, in memory only.
const socketRoom = new Map(); // socketId -> roomId

// Per-socket token-bucket rate limiting, in memory only. Keeps one flooding
// client from drowning a room (messages) or abusing the kick (votes).
const buckets = new Map(); // socketId -> { [kind]: { tokens, last } }
function rateOk(id, kind, perSec, burst) {
  let s = buckets.get(id);
  if (!s) buckets.set(id, (s = {}));
  let b = s[kind];
  const now = Date.now();
  if (!b) b = s[kind] = { tokens: burst, last: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * perSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function brightness(count) {
  // 1 user = dim, 4 users = full blaze. Drives the visual on the client.
  return Math.min(1, count / MAX_PER_ROOM);
}

function emitPresence(room) {
  const people = occupants(room);
  io.to(room.id).emit("presence", {
    roomId: room.id,
    count: people.length,
    max: MAX_PER_ROOM,
    brightness: brightness(people.length),
    users: people,
  });
}

function system(roomId, text) {
  io.to(roomId).emit("system", { text });
}

// Push aggregate, server-wide counts to everyone. Cheap and ephemeral.
function emitStats() {
  io.emit("stats", { ...stats(), max: MAX_PER_ROOM });
}

function seat(socket, avoid = null) {
  const room = findOpenRoom(avoid);
  const me = joinRoom(room, socket.id);
  socket.join(room.id);
  socketRoom.set(socket.id, room.id);

  socket.emit("welcome", {
    roomId: room.id,
    you: { id: socket.id, name: me.name },
    max: MAX_PER_ROOM,
  });
  system(room.id, `${me.name} sat down by the fire.`);
  emitPresence(room);
  emitStats();
  return room;
}

io.on("connection", (socket) => {
  seat(socket);

  socket.on("message", (raw) => {
    // ~3 msgs/sec, tolerating short bursts. Over-limit messages are dropped.
    if (!rateOk(socket.id, "msg", 3, 5)) return;
    const roomId = socketRoom.get(socket.id);
    const room = getRoom(roomId);
    if (!room) return;
    const me = room.users.get(socket.id);
    if (!me) return;

    const text = String(raw ?? "").slice(0, 500).trim();
    if (!text) return;

    // Server is the real gate — never trust the client's filter alone.
    io.to(roomId).emit("message", { from: me.name, text: sanitize(text) });
  });

  // Vote to extinguish (kick). 3-of-4 majority severs the target and drops
  // them into a different fire.
  socket.on("vote", ({ targetId } = {}) => {
    if (!rateOk(socket.id, "vote", 1, 3)) return;
    const roomId = socketRoom.get(socket.id);
    const room = getRoom(roomId);
    if (!room) return;
    const passed = registerVote(room, socket.id, targetId);
    if (!passed) return;

    const target = room.users.get(targetId);
    const kickedName = target?.name ?? "Someone";
    const targetSocket = io.sockets.sockets.get(targetId);

    leaveRoom(room, targetId);
    socketRoom.delete(targetId);
    system(roomId, `${kickedName} was sent off into the dark.`);
    emitPresence(room);
    emitStats();

    if (targetSocket) {
      targetSocket.leave(roomId);
      targetSocket.emit("extinguished");
      seat(targetSocket, roomId); // re-seat at a DIFFERENT fire
    }
  });

  socket.on("disconnect", () => {
    const roomId = socketRoom.get(socket.id);
    const room = getRoom(roomId);
    const me = room?.users.get(socket.id);
    leaveRoom(room, socket.id);
    socketRoom.delete(socket.id);
    buckets.delete(socket.id);
    if (room && me) {
      system(roomId, `${me.name} drifted off into the night.`);
      emitPresence(room);
    }
    emitStats();
  });
});

httpServer.listen(PORT, () => {
  console.log(`Campfire crackling on :${PORT} (${isProd ? "production" : "dev"})`);
});
