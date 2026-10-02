# Local setup and data requirements

## Choose the right starting point

| Goal | Requirements | What to expect |
| --- | --- | --- |
| Read code / run sanity checks | Node 24 | `node scripts/verify-local.mjs` and `npm test` work without installing packages |
| Typecheck / bundle / serve locally | Node 24, npm dependencies | Local Worker and empty local R2; no account login |
| See the complete city | Compatible building and waterway PMTiles files, network, WebGL browser | Seed your local R2; basemap and overlays still depend on external services |
| Rebuild building data | Python geospatial stack, tippecanoe, large remote datasets | Advanced, resource-intensive pipeline; not a setup prerequisite |
| Publish a fork | Your own Cloudflare configuration and reviewed data terms | Separate operational task, not performed by local setup |

`npm ci --ignore-scripts` installs from the committed lockfile without running dependency lifecycle scripts. On the tested Linux x64 / Node 24 environment, the packaged binaries sufficed for Wrangler's dry run. Do not fix a platform-specific binary failure by blindly enabling every install script: identify and review the affected package first.

## Bring your own tile archives

The Worker maps public paths to these exact object keys in its `HCMC_TILES` R2 binding:

| HTTP path | R2 object key |
| --- | --- |
| `/hcmc-buildings.pmtiles` | `buildings/hcmc-v3.pmtiles` |
| `/hcmc-waterways.pmtiles` | `buildings/hcmc-waterways.pmtiles` |
| `/hcmc-buildings-cbd.pmtiles` | `buildings/hcmc-cbd.pmtiles` |

The first two are referenced by the active client; the CBD archive also has a Worker route and discovery pointer. These archives are not committed. There is no bundled downloader that reproduces them.

If you already have compatible, licensed archives, seed the local bucket. These commands use `--local` and the local config; they do not upload to Cloudflare:

```bash
npx wrangler r2 object put hcmc-tiles-local/buildings/hcmc-v3.pmtiles \
  --file /absolute/path/to/hcmc-v3.pmtiles --local --config wrangler.local.toml
npx wrangler r2 object put hcmc-tiles-local/buildings/hcmc-waterways.pmtiles \
  --file /absolute/path/to/hcmc-waterways.pmtiles --local --config wrangler.local.toml
npm run dev
```

Use the same working directory and Wrangler persistence options when seeding and serving. Do not add `--remote`. The building layer expects vector source layer `buildings` with height/base/source attributes consumed in [`public/app.js`](../public/app.js).

Verify the range contract, not just HTTP 200:

```bash
curl -i -H 'Range: bytes=0-127' http://localhost:8787/hcmc-buildings.pmtiles
```

Expect `206`, `Content-Range: bytes 0-127/<size>`, `Content-Length: 128`, and `Accept-Ranges: bytes`. The local unit tests use synthetic bytes to check this protocol; they do not validate any real PMTiles geometry.

## Data-preparation scripts are advanced tooling

[`scripts/bake-buildings.py`](../scripts/bake-buildings.py) imports DuckDB, Rasterio, NumPy, and Shapely, invokes `tippecanoe`, and downloads Overture, Google Open Buildings height tiles, and GHSL inputs. DuckDB also installs its `httpfs` and `spatial` extensions. The phases are `extract`, `heights`, and `bake`.

Important boundaries:

- There is no pinned Python requirements file or complete reproducible data-build environment
- The source currently selects Overture release `2026-09-23.1`
- The output is `out/hcmc-buildings-v2.pmtiles`; the serving code expects `buildings/hcmc-v3.pmtiles`. Do not relabel a v2 output as v3 without checking its intended data/version contract
- Waterway and CBD archive generation are not supplied by this script
- [`scripts/curate-landmarks.py`](../scripts/curate-landmarks.py) makes Overpass requests and rewrites the committed landmark GeoJSON; it is not a read-only check
- Output sizes and production building counts in the HTML are not independently verified from this checkout

No extraction, curation, upload, or paid service is necessary for the offline checks.

## Network dependencies

The browser loads MapLibre and PMTiles scripts from a CDN, Esri satellite imagery, and MapLibre glyphs. The Worker proxies its hard-coded companion origin `https://hcmc.nonarkara.org`. Source constants and exact routes are in the [architecture guide](ARCHITECTURE.md).

Local emulation does not turn those dependencies into offline fixtures. A private network, disabled WebGL, blocked CDN, or missing R2 archive can produce a partial or empty map. The static shell alone is not evidence that 3D rendering works.

## Environment and configuration

- `.nvmrc`: Node 24; package minimum is Node 22.18 for native TypeScript test loading
- `wrangler.local.toml`: local name, local R2 bucket, static assets, no custom domain/account/cron
- `wrangler.toml`: production account ID, route, R2 bucket, and five-minute warmer
- No `.env` file or API key is required by the local source
- `ATLAS_VERSION` and bounding-box `[vars]` in the production TOML are not read by `Env`; the current Worker uses constants in `src/index.ts`
- Optional tool environment: `WRANGLER_SEND_METRICS=false` disables Wrangler telemetry; this is unrelated to app data

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `health.ok: true` but no buildings | `pmtiles.available`; the bucket is empty until seeded |
| `/hcmc-buildings.pmtiles` returns 404 | Exact bucket, key, local persistence directory, and config |
| Browser requests whole archives | Keep `run_worker_first = true`; check byte-range responses |
| Local tests pass, map still blank | Tests mock R2, not WebGL; inspect CDN/map requests and real archives |
| No transit or weather values | Upstream source availability/freshness; this repository does not host those feeds |
| Syntax-stripping test error | Use the Node version in `.nvmrc` |
| Fork tries to use maintainer domain | You used production config; local development uses `npm run dev` |

The production deployment scripts are retained for the maintainer. Do not use them as generic fork setup instructions.
