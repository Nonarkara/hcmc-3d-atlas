# HCMCx 3D Atlas

[Open the atlas](https://atlas.hcmc.nonarkara.org) · [Audit](docs/SHIPABILITY-AUDIT.md)

A public demo for exploring the Ho Chi Minh City skyline. The map preserves metre units while distinguishing tagged heights, satellite estimates, and defaults. A text source ledger remains usable when WebGL or map tiles fail.

The atlas is not a current flood warning service or an official administrative/statistical dataset. Open-Meteo / CAMS air quality is modeled. Flood-area polygons and the metro alignment are indicative. Sensor and bus data carry the upstream tier and observation time; old values never become current merely because they were fetched again.

## Develop and verify

Use Node.js supported by the pinned Wrangler release. Install with `npm ci`, then `npm run dev -- --port 8796`. Local R2 is empty unless you supply tile objects; a missing local archive should show a degraded map and health 503, not fake buildings.

- `npm test`: behavioral client/Worker tests for freshness, missing inputs, invalid payloads, text fallback, layer groups, selected features, reduced motion, Range/HEAD, and health.
- `npm run typecheck`: TypeScript.
- `npm run verify`: static regression checks, including height units and the style-load race.
- `npm run smoke:api`: deployed API behavior.
- `npm run smoke`: deployed asset markers, exact build stamp when `EXPECTED_BUILD` is set, tile Range and CORS.
- `npm run deploy:live`: local gates → build stamp → deployment → live checks. It exits on any failed gate.

The release stamps `public/app.js` and `public/index.html`. Commit the verified generated stamp after deploying so Git records the bytes served. Keep credentials in environment variables or Wrangler's normal authenticated local storage.

## Data and rights

Building features come from Overture Maps (2026-09-23 input release), with Microsoft, Google, and OpenStreetMap source codes. `scripts/bake-buildings.py` records per-feature height source. The input bake contains 4,013,181 features; tile simplification omits small polygons and thins wide views. This is a feature count, not a census of buildings.

Height sources: tagged OSM/survey height; floor count × 3.3 m; Google Open Buildings 2.5D Temporal (2023), footprint p75; GHSL (2018), 100 m area average; type default. Landmark part heights are curated reference models, not measurements of each part.

Data retains its source terms. Consult [Overture attribution](https://docs.overturemaps.org/attribution/), [OpenStreetMap / ODbL](https://www.openstreetmap.org/copyright), [Open-Meteo / CAMS](https://open-meteo.com/en/docs/air-quality-api), and the original height datasets before redistribution. Esri imagery remains subject to Esri's terms. There is no blanket CC-BY license for every dataset or map asset.

The Worker exposes `/api/atlas/*`, `/api/traffic`, `/api/risk`, and `/api/health`. The buildings API is a tile pointer; it does not implement a server-side bbox query. The risk API is experimental and returns no score when an input is missing, stale, or has an invalid observation time. An empty incident feed does not establish that no incident occurred.
