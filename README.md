# 🔥 campfire

A cozy, anonymous, **4-person** ephemeral chat room. No accounts. No database.
No logs. When you close the tab, you were never there.

It's an antidote to the noisy, identity-bound, permanently-archived modern web —
just you and up to three strangers around a fire, talking, then gone.

> 🔥 **Live:** [campfire.arkwright.work](https://campfire.arkwright.work)

## The promise

The architecture is designed so the server **can't** keep records, even if it
wanted to:

- **In-memory only.** Rooms, users, and messages live in the Node process's RAM
  and evaporate when the process restarts. No DB is wired in — by design.
- **No accounts.** You're handed a random ephemeral name on arrival
  (`GlowWorm42`, `CedarFox73`, …).
- **No request logs.** Nginx runs `access_log off;` and the app doesn't forward
  or store client IPs.

## Mechanics

- **4 to a fire.** Each room hard-caps at 4. You're auto-seated at a fire with
  room to spare; a new one is lit when they're all full.
- **The fire reflects the room.** It glows dimmer with one person, full blaze at
  four — driven by a `brightness` value the server pushes on every change.
- **Turned to ash.** Messages containing URLs, emails, or phone numbers are
  blocked (client *and* server) and shown as
  `[Message turned to ash by the fire]`.
- **Vote to extinguish.** A 3-of-4 majority severs a troublemaker and drops them
  into a *different* random fire.
- **Feed the fire.** A 🪵 woodpile button opens a small donation prompt
  (Stripe) — the only "link" in the app, and it's UI chrome, not chat.
- **Help & numbers.** A `?` button explains what Campfire is and how it works;
  a 📊 button shows live, in-memory counters (fires burning, souls online,
  people at your fire, messages you've sent this visit) — aggregate and
  non-identifying, stored nowhere.

## Stack

- **Server:** Node.js + Express + Socket.io (`server/`)
- **Client:** vanilla HTML/CSS/JS, bundled by Vite (`client/`)
- **Shared:** the content filter runs on both sides (`shared/filter.js`)
- **No database.**

## Local development

```bash
npm install
npm run dev      # client on :5173, server on :3000, both watched
```

Open <http://localhost:5173>. Open it in several tabs to fill a fire.

```bash
npm run build    # client → client/dist/
npm start        # production: server serves the built client on :3000
```

## Deployment

Production runs on a **Vultr Ubuntu VPS with CloudPanel**, the app in a **Docker**
container on `127.0.0.1:3002`, with CloudPanel's Nginx reverse-proxying to it,
behind **Cloudflare** (TLS, DDoS, Bot Fight, handshake rate-limiting). The origin
is restricted to Cloudflare IPs **at the campfire vhost level**, so other sites on
the box are unaffected.

**Full step-by-step: [`DEPLOYMENT.md`](./DEPLOYMENT.md).** Supporting files live in
[`deploy/`](./deploy/):

| File | Purpose |
|------|---------|
| `deploy/docker-compose.deploy.yml` | Production compose (loopback-only, prod env) |
| `deploy/cloudpanel-vhost.conf` | Vhost hardening notes (access_log off, IP-blind) |
| `deploy/cloudflare-allow.conf` | Nginx allow-block: Cloudflare edge IPs only |
| `deploy/deploy.sh` | Pull, rebuild image, restart, health-check |

For a quick local/standalone run without CloudPanel, `docker compose up -d`
(binds `:3000`) plus [`nginx.conf.example`](./nginx.conf.example).

## Layout

```
campfire/
├── server/
│   ├── index.js        # Express + Socket.io wiring, presence, voting
│   └── rooms.js        # in-memory room manager (the only "database")
├── client/
│   ├── index.html
│   └── src/
│       ├── main.js     # socket wiring + UI
│       └── style.css   # the campfire aesthetic
├── shared/
│   └── filter.js       # URL/email/phone guardrail (client + server)
├── Dockerfile
├── docker-compose.yml  # simple local run (:3000)
├── nginx.conf.example  # generic standalone reverse proxy
├── DEPLOYMENT.md       # production runbook (CloudPanel + Cloudflare)
└── deploy/             # production compose, vhost + Cloudflare snippets
```

## License

[AGPL-3.0-or-later](./LICENSE). Chosen deliberately: if you run a **modified**
Campfire as a network service, you must publish your source. That means a fork
which quietly adds logging can't legally stay closed — the license backs the
no-records promise. Copyright © 2026 Alex Arkwright.

The AGPL covers the project's **code**. Third-party assets keep their own
licenses — see Credits.

## Credits

- **Ambient audio** — `client/public/ambient.mp3`: *"Campfire Crackling
  Fireplace"* by **soundsforyou** via [Pixabay](https://pixabay.com/sound-effects/)
  (clip ID 119594), used under the [Pixabay Content License](https://pixabay.com/service/license-summary/)
  (free to use, attribution not required but given here).
- **Forest scene** — hand-authored inline SVG (`client/index.html`), original to
  this project.
- **Font** — [VT323](https://fonts.google.com/specimen/VT323) by Peter Hull,
  self-hosted (`client/public/fonts/`) under the
  [SIL Open Font License](https://openfontlicense.org/). Self-hosted so the app
  makes **zero third-party requests**.

## Roadmap / not yet built

- Pixel-art sprite pass on the fire (currently pure CSS)
- Reconnect/seat-restore polish (a reconnect currently re-seats you at a new fire)
