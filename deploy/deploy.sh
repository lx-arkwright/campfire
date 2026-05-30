#!/usr/bin/env bash
#
# Update Campfire in place: pull, rebuild the image, restart the container,
# health-check. Run from the repo root on the server.
#
#   bash deploy/deploy.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

COMPOSE="deploy/docker-compose.deploy.yml"
PORT="${HEALTH_PORT:-3002}"
# Pin the project name so the container is recreated in place regardless of which
# directory the compose file lives in (otherwise Compose derives it from deploy/
# and collides with the existing `campfire` container).
PROJECT="campfire"

echo "==> Pulling latest…"
git pull --ff-only

echo "==> Building + restarting…"
docker compose -p "$PROJECT" -f "$COMPOSE" up -d --build

echo "==> Health check…"
for _ in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" || true)"
  [ "$code" = "200" ] && { echo "    OK (200)"; exit 0; }
  sleep 1
done
echo "    WARNING: origin did not return 200 — check: docker logs campfire"
exit 1
