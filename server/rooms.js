// In-memory room manager. NOTHING here is persisted — when the process dies,
// every room, user, and message is gone. That is the whole point.

export const MAX_PER_ROOM = 4;

const ADJECTIVES = ["Glow", "Pine", "Ash", "Ember", "Dusk", "Moss", "Cedar", "Fern", "Birch", "Smoke", "Quiet", "Amber"];
const CREATURES = ["Worm", "Coyote", "Cone", "Owl", "Moth", "Fox", "Hare", "Newt", "Wren", "Toad", "Lynx", "Crow"];

let roomSeq = 0;

// roomId -> { id, users: Map<socketId, { name, votesAgainst: Set<socketId> }> }
const rooms = new Map();

function makeName() {
  // Deterministic-free randomness is fine here; collisions inside a 4-person
  // room are re-rolled by the caller.
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const c = CREATURES[Math.floor(Math.random() * CREATURES.length)];
  const n = Math.floor(Math.random() * 90) + 10;
  return `${a}${c}${n}`;
}

function newRoom() {
  const id = `fire-${++roomSeq}`;
  const room = { id, users: new Map() };
  rooms.set(id, room);
  return room;
}

// Find a room with a free seat, or light a new fire. `avoid` lets a kicked
// user skip the room they were just thrown out of.
export function findOpenRoom(avoid = null) {
  for (const room of rooms.values()) {
    if (room.id !== avoid && room.users.size < MAX_PER_ROOM) return room;
  }
  return newRoom();
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
  if (room.users.size === 0) rooms.delete(room.id);
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
