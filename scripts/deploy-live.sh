#!/bin/bash
# HCMCx 3D Atlas — preferred live deploy.
# Pull → marker check → whoami → deploy → wait for edge cache → verify.
#
# Do NOT trust the first curl right after upload — Workers assets often
# return a stale `cf-cache-status: HIT` for ~10s.

set -euo pipefail

ATLAS_HTML_MARKER='id="atlas-map"'
WRANGLI_BIN="${WRANGLI_BIN:-npx wrangler}"

echo "→ git status"
git status --short

echo "→ marker check: $ATLAS_HTML_MARKER"
grep -q "$ATLAS_HTML_MARKER" public/index.html || { echo "Marker missing — abort"; exit 1; }

echo "→ wrangler whoami"
$WRANGLI_BIN whoami | sed -n 1,3p  # head -3 closed the pipe early; pipefail aborted on EPIPE

echo "→ deploy"
$WRANGLI_BIN deploy

echo "→ waiting 12s for edge cache"
sleep 12

ATLAS_URL="${ATLAS_URL:-https://atlas.hcmc.nonarkara.org}"
echo "→ verify $ATLAS_URL"
curl -sL "$ATLAS_URL/" | grep -c "$ATLAS_HTML_MARKER" | xargs -I{} echo "  HTML marker count: {} (expect ≥ 1)"
curl -sL "$ATLAS_URL/" | grep -c "atlas.areas" | xargs -I{} echo "  areas route: {} (expect ≥ 1)"
curl -sL "$ATLAS_URL/api/atlas/scoreboard" | head -c 200
echo
echo "→ smoke"
node scripts/smoke-atlas-api.mjs
