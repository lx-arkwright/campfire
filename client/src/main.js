import "./style.css";
import { io } from "socket.io-client";
import { isContraband, ASH_MESSAGE } from "../../shared/filter.js";

// In dev, Vite serves this on :5173 while the Node/Socket.io server is on
// :3000. In production they share an origin, so connect to same-origin.
const socket = import.meta.env.DEV ? io("http://localhost:3000") : io();

const $ = (sel) => document.querySelector(sel);
const scene = $("#scene");
const logEl = $("#log");
const seatsEl = $("#seats");
const presenceEl = $("#presence");
const form = $("#composer");
const input = $("#input");
const muteBtn = $("#mute");
const ambient = $("#ambient");
const woodpileBtn = $("#woodpile");
const woodpilePanel = $("#woodpile-panel");
const helpBtn = $("#help");
const helpPanel = $("#help-panel");
const statsBtn = $("#stats");
const statsPanel = $("#stats-panel");
const emojiBtn = $("#emoji");
const emojiPanel = $("#emoji-panel");
const inviteBtn = $("#invite");
const wanderBtn = $("#wander");

let me = null; // { id, name }
let roster = []; // [{ id, name }]

// Session-only analytics. None of this leaves the tab except the message you
// actually send; the counters below are just for your own curiosity.
let sentCount = 0;
let atFire = 0;
let server = { fires: 0, souls: 0, max: 4 };

// Lobby / arrival state.
let waiting = false; // true while warming up in the lobby
let prevCount = 0; // last room headcount, to detect arrivals
let justSeated = false; // suppress the arrival chime for your own seating
let waitEl = null; // the live "warming up" status line
let audioCtx = null;
let titlePinged = false;
const BASE_TITLE = "campfire";
// An invite link (#f-<token>) sends us to a specific fire on first connect only.
const tokenMatch = (location.hash || "").match(/^#f-([a-z0-9]+)$/i);
let pendingToken = tokenMatch ? tokenMatch[1] : null;
if (tokenMatch) history.replaceState(null, "", location.pathname + location.search);

// Local clock only — computed in the browser, never sent or stored.
function timeTag() {
  const d = new Date();
  const t = document.createElement("span");
  t.className = "line__time";
  t.textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} `;
  return t;
}

function line(text, kind = "system", withTime = false) {
  const el = document.createElement("div");
  el.className = `line line--${kind}`;
  if (withTime) el.appendChild(timeTag());
  el.appendChild(document.createTextNode(text));
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

function chat(from, text) {
  const el = document.createElement("div");
  el.className = "line line--chat";
  const who = document.createElement("span");
  who.className = "line__who";
  who.textContent = `${from}: `;
  if (me && from === me.name) who.classList.add("line__who--me");
  el.append(timeTag(), who, document.createTextNode(text));
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderSeats() {
  seatsEl.innerHTML = "";
  for (const u of roster) {
    const li = document.createElement("li");
    li.className = "seat";
    const isMe = me && u.id === me.id;
    li.textContent = isMe ? `${u.name} (you)` : u.name;
    if (!isMe) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "seat__vote";
      btn.title = "Vote to extinguish";
      btn.textContent = "✕";
      btn.addEventListener("click", () => socket.emit("vote", { targetId: u.id }));
      li.appendChild(btn);
    }
    seatsEl.appendChild(li);
  }
}

function renderStats() {
  $("#stat-fires").textContent = server.fires;
  $("#stat-souls").textContent = server.souls;
  $("#stat-fire").textContent = `${atFire}/${server.max}`;
  $("#stat-sent").textContent = sentCount;
}

// --- lobby / arrival helpers -----------------------------------------------

function setBrightness(b) {
  scene.dataset.brightness = b.toFixed(2);
  scene.style.setProperty("--brightness", b);
}

function composerDisabled(on) {
  input.disabled = on;
  input.placeholder = on ? "waiting for the fire to catch…" : "say something into the dark…";
}

function showWander(on) {
  wanderBtn.hidden = !on;
}

// A quick brighten of the whole scene when someone arrives or you get seated.
function flare() {
  scene.classList.remove("scene--flare");
  void scene.offsetWidth; // restart the animation
  scene.classList.add("scene--flare");
}

// A soft two-note blip — only if the user has opted into sound (unmuted).
function chime() {
  if (muted) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    const t = audioCtx.currentTime;
    o.frequency.setValueAtTime(660, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.45);
  } catch {
    /* audio not available — no big deal */
  }
}

// Nudge the tab title so someone who switched away notices a new arrival.
function titlePing() {
  if (document.hidden) {
    document.title = "🔥 someone's here · campfire";
    titlePinged = true;
  }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && titlePinged) {
    document.title = BASE_TITLE;
    titlePinged = false;
  }
});

function showWaiting(p) {
  waiting = true;
  atFire = 0;
  composerDisabled(true);
  showWander(false);
  seatsEl.innerHTML = "";
  presenceEl.textContent = "· warming ·";
  setBrightness(0.12);
  if (!waitEl) {
    waitEl = document.createElement("div");
    waitEl.className = "line line--system";
    logEl.appendChild(waitEl);
  }
  const others = Math.max(0, (p.waiting || 1) - 1);
  const elsewhere = Math.max(0, (p.souls || 0) - (p.waiting || 0));
  if (others > 0) {
    waitEl.textContent = `Warming up by the embers… ${others} other${others > 1 ? "s" : ""} waiting too — a fire's about to catch.`;
  } else if (elsewhere > 0) {
    waitEl.textContent = `Warming up by the embers — waiting for someone to wander in. (${elsewhere} soul${elsewhere > 1 ? "s" : ""} at ${p.fires} other fire${p.fires > 1 ? "s" : ""} right now.)`;
  } else {
    waitEl.textContent = "Warming up by the embers — you're first tonight. Stick around, or send a friend your invite link (🔗).";
  }
  logEl.scrollTop = logEl.scrollHeight;
  renderStats();
}

function clearWaiting() {
  waiting = false;
  composerDisabled(false);
  if (waitEl) {
    waitEl.remove();
    waitEl = null;
  }
}

// --- socket wiring ---------------------------------------------------------

// Ask to join once connected (an invite token only applies on the first connect).
socket.on("connect", () => {
  socket.emit("join", { token: pendingToken });
  pendingToken = null;
});

socket.on("lobby", (p) => {
  server = { ...server, fires: p.fires, souls: p.souls, max: p.max };
  showWaiting(p);
});

socket.on("welcome", (data) => {
  const wasWaiting = waiting;
  clearWaiting();
  me = data.you;
  justSeated = true;
  prevCount = 0;
  showWander(true);
  line(`You are ${me.name}. Up to ${data.max} around this fire.`, "you");
  if (data.reserved) {
    line("You've lit a fire and you're holding it — tap 🔗 for your invite link and bring someone.", "you");
  } else if (wasWaiting) {
    line("The fire catches — you're not alone now. Say hello.", "system");
  } else {
    line("You pull up a log by the fire. Say hello.", "system");
  }
  flare();
  if (!input.disabled) input.focus();
});

socket.on("presence", (p) => {
  const increased = p.count > prevCount;
  prevCount = p.count;
  roster = p.users;
  atFire = p.count;
  server.max = p.max;
  presenceEl.textContent = `· ${p.count}/${p.max} ·`;
  setBrightness(p.brightness);
  renderSeats();
  renderStats();
  if (increased && !waiting && !justSeated) {
    flare();
    chime();
    titlePing();
  }
  justSeated = false;
});

socket.on("stats", (s) => {
  server = { ...server, ...s };
  renderStats();
});

socket.on("system", ({ text }) => line(text, "system", true));
socket.on("message", ({ from, text }) => chat(from, text));

socket.on("invite-link", ({ token }) => {
  const url = `${location.origin}/#f-${token}`;
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).catch(() => {});
  line(`Invite link copied — share it to fill your fire: ${url}`, "you");
});

socket.on("extinguished", () => {
  line("The others voted. You drift off to find a new fire…", "warn");
  logEl.querySelectorAll(".line--chat").forEach((n) => n.remove());
});

socket.on("disconnect", () => line("The fire went out. Reconnecting…", "warn"));

// Bar actions
inviteBtn.addEventListener("click", () => socket.emit("invite"));
wanderBtn.addEventListener("click", () => socket.emit("wander"));

// --- composer --------------------------------------------------------------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (waiting) return;
  const text = input.value.trim();
  if (!text) return;
  // Instant client-side feedback; the server enforces this for real too.
  if (isContraband(text)) {
    line(ASH_MESSAGE, "warn");
  } else {
    socket.emit("message", text);
    sentCount++;
    renderStats();
  }
  input.value = "";
  input.focus();
});

// --- popovers (help / analytics / donation) --------------------------------
// Each bar button toggles its panel; opening one closes the others. Clicking
// outside any open panel, or pressing Escape, closes everything.

const popovers = [
  [helpBtn, helpPanel],
  [statsBtn, statsPanel],
  [woodpileBtn, woodpilePanel],
  [emojiBtn, emojiPanel],
];

function showPanel(panel) {
  for (const [btn, p] of popovers) {
    const open = p === panel;
    p.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  }
}

for (const [btn, panel] of popovers) {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    showPanel(panel.hidden ? panel : null);
  });
}
document.addEventListener("click", (e) => {
  const insideOpen = popovers.some(([, p]) => !p.hidden && p.contains(e.target));
  if (!insideOpen) showPanel(null);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") showPanel(null);
});

// --- emoji picker ----------------------------------------------------------
// A curated set (campfire / nature / faces / hearts) — no heavy library.
// Clicking one inserts it at the caret and keeps the picker open so you can
// stack a few. Typed Unicode emoji already work; this is just for convenience.

const EMOJIS = [
  "🔥","🪵","🏕️","⛺","🌲","🌳","🍂","🍁","🍄","🌙","✨","🌟","⭐","🌌",
  "😀","😄","😊","🙂","😉","😎","😅","😂","🤣","🙃","😌","😇","🤔","😴",
  "🥹","🥲","😢","😭","😮","😱","🤯","🥳","😍","🥰","😘","🤗","🤫","😈",
  "👍","👎","👋","🙌","👏","🙏","💪","🫶","☕","🍵","🎶","🦊","🦉","🐺",
  "❤️","🧡","💛","💚","💙","💜","🤍","🖤",
];

for (const e of EMOJIS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "emoji-panel__item";
  b.textContent = e;
  b.setAttribute("aria-label", e);
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    insertAtCaret(e);
  });
  emojiPanel.appendChild(b);
}

function insertAtCaret(text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  input.focus();
}

// --- ambient audio ---------------------------------------------------------
// Audio file isn't bundled yet — drop a loop at client/public/ambient.mp3 and
// it'll play. Muted-by-default until the first interaction (browser policy).

let muted = true;
function refreshMute() {
  muteBtn.textContent = muted ? "♪̶" : "♪";
  muteBtn.classList.toggle("is-muted", muted);
  ambient.muted = muted;
}
muteBtn.addEventListener("click", () => {
  muted = !muted;
  if (!muted) {
    ambient.src = ambient.src || "/ambient.mp3";
    ambient.play().catch(() => {});
  }
  refreshMute();
});
refreshMute();
