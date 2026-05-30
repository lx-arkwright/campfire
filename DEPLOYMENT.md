# Deploying Campfire

How `campfire.arkwright.work` is deployed: a **Vultr Ubuntu VPS running
CloudPanel** (shared with other sites), the app in a **Docker** container on
`127.0.0.1:3002`, CloudPanel's Nginx reverse-proxying to it, behind **Cloudflare**
for TLS and edge security. The origin is restricted to Cloudflare **at the
campfire vhost level** (not the host firewall), so other sites on the box are
unaffected.

```
User → Cloudflare (orange-cloud: TLS, DDoS, Bot Fight, rate-limit handshake)
     → Vultr VPS  [campfire vhost: allow Cloudflare IPs, deny all]
     → CloudPanel Nginx reverse proxy (WebSocket + access_log off)
     → 127.0.0.1:3002 → Docker container (campfire)
```

## Defense-in-depth, by layer

| Layer | Stops | Where |
|-------|-------|-------|
| Cloudflare rate-limit on `/socket.io/` | Mass connection flooding | Cloudflare WAF |
| Cloudflare Bot Fight + DDoS | Bots, volumetric attacks | Cloudflare (free) |
| Vhost allow-block → Cloudflare IPs only | Direct-to-origin bypass | campfire vhost (**not** host ufw) |
| Strict CSP + security headers | Script injection / clickjacking | `server/index.js` (prod) |
| Per-socket rate limiter | In-socket message/vote spam | `server/index.js` |
| Vote floor (`MIN_VOTES_TO_KICK`) | Griefing the kick in small rooms | `server/rooms.js` |

> **Why per-vhost, not the host firewall.** On a shared CloudPanel box, `ufw` is
> server-wide — locking 80/443 to Cloudflare would hit *every* site. Restricting
> at the campfire `server { }` block protects this origin without touching the
> others.
>
> **Privacy note.** Proxying through Cloudflare means Cloudflare terminates TLS
> and sees connection IPs/metadata. The origin keeps `access_log off` and does
> **not** forward client IPs to the app, so the app stays IP-blind — but
> Cloudflare is in the trust boundary. A deliberate trade-off.

---

## 0. Prerequisites

- Ubuntu with **Docker + Compose v2** (a CloudPanel box running other Docker apps
  already has it; otherwise `apt-get install -y docker.io docker-compose-v2`).
- **CloudPanel** + a domain on **Cloudflare**.
- A free loopback TCP port (this deploy uses **3002**; pick any unused one — check
  with `ss -ltn`).

---

## 1. App container

```bash
git clone https://github.com/lx-arkwright/campfire.git /opt/campfire
cd /opt/campfire
# deploy/docker-compose.deploy.yml binds 127.0.0.1:3002 and sets prod env.
# Edit the host port / PUBLIC_ORIGIN there if yours differ.
docker compose -p campfire -f deploy/docker-compose.deploy.yml up -d --build
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/   # expect 200
```

The container binds **loopback only** (`127.0.0.1:3002`), `restart: unless-stopped`,
and Docker starts on boot — so it survives reboots.

---

## 2. CloudPanel reverse-proxy site

```bash
clpctl site:add:reverse-proxy \
  --domainName=campfire.arkwright.work \
  --reverseProxyUrl=http://127.0.0.1:3002 \
  --siteUser=campfire \
  --siteUserPassword='<generated-strong-password>'
```

(Or CloudPanel UI → Sites → Add Site → Create a Reverse Proxy.) CloudPanel's
template already includes the WebSocket `Upgrade`/`Connection` headers.

---

## 3. Cloudflare (dashboard)

1. **DNS** → A record `campfire` → your VPS IP, **Proxied (🟠)**.
2. **SSL/TLS** → **Full (Strict)**.
3. **SSL/TLS → Origin Server → Create Certificate** → install the cert + key in
   CloudPanel (Site → SSL/TLS → Import Certificate). Origin certs need no renewal,
   which pairs well with locking the origin to Cloudflare.
4. **Network → WebSockets: On**.
5. **Security → WAF → Rate limiting** → rule:
   `(http.host eq "campfire.arkwright.work" and starts_with(http.request.uri.path, "/socket.io/"))`,
   **30 req / 1 min per IP**, action **Managed Challenge** (friendly to shared
   VPN/Tor IPs).
6. **Security → Bots → Bot Fight Mode: On**.

---

## 4. Harden the campfire vhost

Apply three edits to `/etc/nginx/sites-enabled/campfire.arkwright.work.conf`
(see [`deploy/cloudpanel-vhost.conf`](deploy/cloudpanel-vhost.conf) for the exact
changes):

1. `access_log off;` (replace the `access_log … main;` line) — no origin logging.
2. Paste [`deploy/cloudflare-allow.conf`](deploy/cloudflare-allow.conf) after the
   `error_log` line — `allow <cloudflare ranges>; deny all;` so only Cloudflare
   reaches this origin.
3. Blank the client-IP headers in the `@reverse_proxy` block so the app stays
   IP-blind: `proxy_set_header X-Real-IP ""; proxy_set_header X-Forwarded-For "";`

```bash
nginx -t && systemctl reload nginx
```

> **Heads up:** editing this site in the CloudPanel **UI** may regenerate the
> vhost and wipe these edits — re-apply them if that happens.

---

## 5. Verify

```bash
curl -sI https://campfire.arkwright.work | head -1                         # 200 via Cloudflare
curl -sk -o /dev/null -w '%{http_code}\n' \
  --resolve campfire.arkwright.work:443:<VPS_IP> https://campfire.arkwright.work/   # 403 = origin locked
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://campfire.arkwright.work/socket.io/?EIO=4&transport=polling"     # 200 handshake
```

Then open the site, fill a fire across a few tabs, and confirm presence/chat work
and DevTools → Network shows **no third-party requests**.

---

## 6. Update / redeploy

```bash
cd /opt/campfire && bash deploy/deploy.sh   # pull, rebuild image, restart, health-check
```

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Cloudflare **526** | Origin still on self-signed cert under Full (Strict) — install the Origin Cert (step 3) |
| Cloudflare **521/522** | Container down, wrong proxy port, or origin not reachable from Cloudflare |
| Presence stuck 0/4, chat dead | WebSockets off in Cloudflare, or vhost missing the `Upgrade` headers |
| **403 through Cloudflare** too | Cloudflare range list in the allow-block is stale — refresh from cloudflare.com/ips |
| Works on the raw IP | Vhost allow-block not applied — re-run step 4 |
