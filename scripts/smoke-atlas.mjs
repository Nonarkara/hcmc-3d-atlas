#!/usr/bin/env node
// Smoke test for the live atlas. Runs after `wrangler deploy` and fails
// loudly if the bundle regresses on any of the things that have bitten us:
//
//   - the once("load") vs loaded() race (no PMTiles source registered)
//   - missing hcmc-buildings layer after onMapReady
//   - missing postMsg ready handshake
//   - missing asset cache-buster on app.js / style.css
//
// Usage: ATLAS_BASE=https://hcmc-3d-atlas.drnon.workers.dev node scripts/smoke-atlas.mjs
// Exit code 0 = pass, 1 = fail.

import { strict as assert } from "node:assert";

const BASE = process.env.ATLAS_BASE || "https://hcmc-3d-atlas.drnon.workers.dev";

async function fetchText(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.text();
}

async function fetchHead(path) {
  const r = await fetch(BASE + path, { method: "HEAD" });
  return { status: r.status, headers: Object.fromEntries(r.headers) };
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}  ${e.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log(`Smoke-testing ${BASE}`);

  const html = await fetchText("/");
  const appJs = await fetchText(
    html.match(/src="\/app\.js\?v=[^"]+"/)[0].replace(/src="|"/g, ""),
  );

  await check("index.html references app.js with cache-buster", async () => {
    assert.match(html, /\/app\.js\?v=hcmc-atlas-/, "no app.js cache-buster");
  });

  await check("index.html references style.css with cache-buster", async () => {
    assert.match(html, /\/style\.css\?v=hcmc-atlas-/, "no style.css cache-buster");
  });

  // A preload fetches the whole archive (10+ MB) with no Range header.
  await check("index.html does not preload PMTiles", async () => {
    assert.doesNotMatch(html, /<link rel="preload"[^>]+\.pmtiles/);
  });

  await check("app.js declares ATLAS_BUILD_TAG", async () => {
    assert.match(
      appJs,
      /const ATLAS_BUILD_TAG = "hcmc-atlas-\d{8}-\d+-[0-9a-zA-Z_-]+";/,
      "ATLAS_BUILD_TAG should look like hcmc-atlas-YYYYMMDD-<epoch>-<sha|local>",
    );
  });

  await check("app.js adds layers on style.load, not after every tile", async () => {
    assert.match(appJs, /mapInstance\.isStyleLoaded\(\)/, "no isStyleLoaded() check");
    assert.match(appJs, /mapInstance\.once\("style\.load"/, "no style.load fallback");
  });

  await check("app.js adds the buildings layer (hcmc-buildings)", async () => {
    assert.match(appJs, /id:\s*"hcmc-buildings"/);
  });

  await check("app.js adds the waterways layer", async () => {
    assert.match(appJs, /id:\s*"waterways-line"/);
  });

  await check("app.js calls applyAllLayers() from onMapReady", async () => {
    assert.match(appJs, /applyAllLayers\(\);/);
  });

  await check("app.js posts a ready handshake with version + sources", async () => {
    assert.match(appJs, /postMsg\("ready",\s*\{/, "no ready postMessage");
    assert.match(appJs, /ATLAS_BUILD_TAG/, "build tag not referenced in ready payload");
    assert.match(appJs, /buildingsPresent/, "no buildingsPresent flag");
  });

  await check("app.js has a fail-loud self-test for missing buildings", async () => {
    assert.match(appJs, /hcmc-buildings.*missing after onMapReady|buildings layer is missing/i);
  });

  await check("/hcmc-buildings.pmtiles responds with Range support", async () => {
    const r = await fetch(BASE + "/hcmc-buildings.pmtiles", {
      headers: { Range: "bytes=0-127" },
    });
    assert.equal(r.status, 206, "expected 206 Partial Content");
    const cr = r.headers.get("content-range");
    assert.match(cr, /^bytes 0-127\/\d+$/, `expected content-range like bytes 0-127/<size>, got ${cr}`);
  });

  await check("/hcmc-waterways.pmtiles responds with Range support", async () => {
    const r = await fetch(BASE + "/hcmc-waterways.pmtiles", {
      headers: { Range: "bytes=0-127" },
    });
    assert.equal(r.status, 206, "expected 206 Partial Content");
  });

  await check("/hcmc-buildings.pmtiles has CORS for the dashboard origin", async () => {
    const r = await fetch(BASE + "/hcmc-buildings.pmtiles", {
      method: "OPTIONS",
      headers: {
        Origin: "https://hcmc.nonarkara.org",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });

  const ok = process.exitCode !== 1;
  console.log(ok ? "\nALL PASS" : "\nFAILURES -- see above");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(2);
});