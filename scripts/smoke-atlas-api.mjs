#!/usr/bin/env node
// HCMCx 3D Atlas — smoke test the live (or local) API surface.
//
// 11 checks: every /api/atlas/* endpoint + scoreboard + filter + bad bbox
// + malformed bbox. Exits non-zero on any failure.
//
// Usage:
//   node scripts/smoke-atlas-api.mjs                  # live atlas
//   ATLAS_URL=http://localhost:8787 node scripts/smoke-atlas-api.mjs  # local

const ATLAS_URL = (process.env.ATLAS_URL || "https://atlas.hcmc.nonarkara.org").replace(/\/$/, "");

const CHECKS = [];
function check(name, ok, detail = "") {
  CHECKS.push({ name, ok, detail });
}

async function get(path) {
  const url = `${ATLAS_URL}${path}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

(async () => {
  console.log(`HCMCx 3D Atlas smoke · ${ATLAS_URL}`);

  // 1-2: Areas + corridors
  {
    const r = await get("/api/atlas/areas?bbox=106.30,10.35,107.05,11.20");
    check("atlas.areas returns ok + count > 0", r.status === 200 && r.body?.count > 0, `${r.status} count=${r.body?.count}`);
  }
  {
    const r = await get("/api/atlas/corridors");
    check("atlas.corridors returns 6", r.status === 200 && r.body?.corridors?.length === 6, `${r.status} corridors=${r.body?.corridors?.length}`);
  }
  // 3: Districts
  {
    const r = await get("/api/atlas/districts");
    check("atlas.districts has 20+ districts", r.status === 200 && r.body?.count >= 20, `${r.status} count=${r.body?.count}`);
  }
  // 4: At-this-point (a governor corridor centre)
  {
    const r = await get("/api/atlas/at-this-point?lng=106.7009&lat=10.775");
    check("atlas.at-this-point locates District 1", r.status === 200 && r.body?.location?.nearestArea?.id === "district-1-cbd", `${r.status} nearest=${r.body?.location?.nearestArea?.id}`);
  }
  // 5: Transit — a metro/bus look-up
  {
    const r = await get("/api/atlas/transit?lng=106.7009&lat=10.7900&radius=20");
    check("atlas.transit returns a vehicle", r.status === 200 && Array.isArray(r.body?.transit) && r.body.transit.length > 0, `${r.status} items=${r.body?.transit?.length}`);
  }
  // 6: Buildings — returns a pointer, not fake data
  {
    const r = await get("/api/atlas/buildings?bbox=106.70,10.77,106.72,10.79");
    check("atlas.buildings points to PMTiles", r.status === 200 && typeof r.body?.pointer?.pmtiles === "string", `${r.status} pointer=${r.body?.pointer?.pmtiles}`);
  }
  // 7: Scoreboard — single object
  {
    const r = await get("/api/atlas/scoreboard");
    check("atlas.scoreboard returns feeds", r.status === 200 && typeof r.body?.feeds === "object", `${r.status} feeds=${Object.keys(r.body?.feeds || {}).length}`);
  }
  // 8: City events — GeoJSON FeatureCollection
  {
    const r = await get("/api/atlas/city-events");
    check("atlas.city-events returns FeatureCollection", r.status === 200 && r.body?.features?.type === "FeatureCollection", `${r.status} count=${r.body?.count}`);
  }
  // 9: Risk — score 0-100
  {
    const r = await get("/api/risk?lng=106.65&lat=10.78");
    check("/api/risk returns score in range", r.status === 200 && Number.isFinite(r.body?.score) && r.body.score >= 0 && r.body.score <= 100, `${r.status} score=${r.body?.score}`);
    check("/api/risk reads pm25, not an empty object", Number.isFinite(r.body?.factors?.pm25), `pm25=${r.body?.factors?.pm25}`);
  }
  {
    const r = await get("/api/traffic");
    check("traffic exposes observation freshness", r.status === 200 && typeof r.body?.sensorFreshness?.stale === "boolean" && Array.isArray(r.body?.sensors) && r.body.sensors.every(s => typeof s.stale === "boolean"), `${r.status} stale=${r.body?.sensorFreshness?.stale}`);
  }
  // 10: Out-of-bbox — 400
  {
    const r = await get("/api/atlas/at-this-point?lng=0&lat=0");
    check("atlas.at-this-point rejects out-of-bbox", r.status === 400 && r.body?.error === "out_of_hcmc_bbox", `${r.status} error=${r.body?.error}`);
  }
  // 11: Malformed coords — 400
  {
    const r = await get("/api/atlas/at-this-point?lng=abc&lat=xyz");
    check("atlas.at-this-point rejects invalid input", r.status === 400 && r.body?.error === "invalid_coordinates", `${r.status} error=${r.body?.error}`);
  }

  let pass = 0;
  for (const c of CHECKS) {
    const sym = c.ok ? "✓" : "✗";
    const detail = c.detail ? `  ${c.detail}` : "";
    console.log(`  ${sym} ${c.name}${detail}`);
    if (c.ok) pass++;
  }
  console.log(`\n${pass}/${CHECKS.length} passed`);
  if (pass !== CHECKS.length) process.exit(1);
})();
