// In-memory room manager. NOTHING here is persisted — when the process dies,
// every room, user, and message is gone. That is the whole point.

export const MAX_PER_ROOM = 4;

const ADJECTIVES = ["Glow", "Pine", "Ash", "Ember", "Dusk", "Moss", "Cedar", "Fern", "Birch", "Smoke", "Quiet", "Amber"];
const CREATURES = ["Worm", "Coyote", "Cone", "Owl", "Moth", "Fox", "Hare", "Newt", "Wren", "Toad", "Lynx", "Crow"];

let roomSeq = 0;

// roomId -> { id, token, reserved, users: Map<socketId, { name, votesAgainst }> }
const rooms = new Map();
// invite token -> room. Tokens are random and unguessable, so fires can't be
// enumerated by their sequential id. They die with the room.
const tokenIndex = new Map();

function makeToken() {
  let t;
  do {
    t = Math.random().toString(36).slice(2, 10);
  } while (tokenIndex.has(t));
  return t;
}

function makeName() {
  // Deterministic-free randomness is fine here; collisions inside a 4-person
  // room are re-rolled by the caller.
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const c = CREATURES[Math.floor(Math.random() * CREATURES.length)];
  const n = Math.floor(Math.random() * 90) + 10;
  return `${a}${c}${n}`;
}

// Light a fresh fire. `reserved` fires are held for an invited friend and are
// skipped by automatic placement until the friend arrives (or it times out).
export function createRoom({ reserved = false } = {}) {
  const id = `fire-${++roomSeq}`;
  const token = makeToken();
  const room = { id, token, reserved, users: new Map() };
  rooms.set(id, room);
  tokenIndex.set(token, room);
  return room;
}

// A fire that already has company AND a free seat — what a newcomer should join
// so they're never seated alone. Reserved (invite-held) fires are skipped.
export function findOccupiedOpenRoom(avoid = null) {
  for (const room of rooms.values()) {
    if (room.id === avoid || room.reserved) continue;
    if (room.users.size >= 1 && room.users.size < MAX_PER_ROOM) return room;
  }
  return null;
}

// The non-full fire with the MOST people — for "wander to a livelier fire".
export function findBusiestOpenRoom(avoid = null) {
  let best = null;
  for (const room of rooms.values()) {
    if (room.id === avoid || room.reserved) continue;
    if (room.users.size >= 1 && room.users.size < MAX_PER_ROOM) {
      if (!best || room.users.size > best.users.size) best = room;
    }
  }
  return best;
}

export function getRoomByToken(token) {
  return tokenIndex.get(token);
}

export function joinRoom(room, socketId) {
  const existing = new Set([...room.users.values()].map((u) => u.name));
  let name = makeName();
  while (existing.has(name)) name = makeName();
  room.users.set(socketId, { name, votesAgainst: new Set() });
  return room.users.get(socketId);
}

export function leaveRoom(room, socketId) {
  if (!room) return;
  room.users.delete(socketId);
  // Clear any votes that referenced the departed user.
  for (const u of room.users.values()) u.votesAgainst.delete(socketId);
  if (room.users.size === 0) {
    rooms.delete(room.id);
    tokenIndex.delete(room.token);
  }
}

export function getRoom(roomId) {
  return rooms.get(roomId);
}

// Public-safe snapshot of who's at the fire.
export function occupants(room) {
  return [...room.users.entries()].map(([id, u]) => ({ id, name: u.name }));
}

// Aggregate, non-identifying snapshot for the analytics panel. Computed on the
// fly from current memory — like everything here, nothing is stored.
export function stats() {
  let souls = 0;
  for (const room of rooms.values()) souls += room.users.size;
  return { fires: rooms.size, souls };
}

// A kick always needs at least this many distinct voters, so the "3 of 4"
// promise can't collapse in a half-empty room (e.g. one person evicting the
// only other occupant). In practice this means kicks only pass in full rooms.
export const MIN_VOTES_TO_KICK = 3;

// Record one vote. Returns true once enough of the OTHER currently-present
// users want the target gone. Votes from people who've since left don't count.
export function registerVote(room, voterId, targetId) {
  const target = room.users.get(targetId);
  if (!target || voterId === targetId || !room.users.has(voterId)) return false;
  target.votesAgainst.add(voterId);

  // Count only voters still in the room (guards against stale/ghost votes).
  let present = 0;
  for (const id of target.votesAgainst) {
    if (id !== targetId && room.users.has(id)) present++;
  }
  const needed = Math.max(MIN_VOTES_TO_KICK, room.users.size - 1);
  return present >= needed;
}
