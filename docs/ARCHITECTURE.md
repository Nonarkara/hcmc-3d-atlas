# Architecture and API

![HCMC request and source flow](assets/architecture.svg)

The illustration is original, editable SVG. It describes the checked-in code, not a production availability claim.

## Source map

| Component | Source | Responsibility |
| --- | --- | --- |
| Viewer | [`public/app.js`](../public/app.js), [`index.html`](../public/index.html) | Map construction, PMTiles registration, layers, click inspector, area navigation, upstream overlay polling |
| Visual system | [`public/style.css`](../public/style.css) | Dark editorial palette, square edges, thin rules, signal accents |
| Curated navigation | [`public/hcmc-areas.json`](../public/hcmc-areas.json) | 12 named areas, categories, six corridors, camera presets |
| Curated landmarks | [`public/hcmc-landmarks.geojson`](../public/hcmc-landmarks.geojson) | OSM element references, footprints, per-feature height source |
| Edge router | [`src/index.ts`](../src/index.ts) | Static assets, JSON APIs, CORS, cached companion-dashboard requests |
| Archive gateway | `servePmtilesFromR2`, `streamRange` in the Worker | R2 byte-range reads, suffix/clamped ranges, 416 bounds response, ETag and CORS |
| Build identity | [`scripts/stamp-build-id.mjs`](../scripts/stamp-build-id.mjs) | Rewrites frontend asset cache-busters and iframe build tag |
| Scheduled warmer | Worker `scheduled` handler + production TOML | Requests the configured upstream feed paths every five minutes |

## API surface

All coordinate inputs are WGS84 longitude/latitude. Point APIs enforce the source bounding box: longitude 106.30–107.05 and latitude 10.35–11.20. Bbox syntax, where supported, is `west,south,east,north`.

| Route | Main inputs | Data dependency / behavior |
| --- | --- | --- |
| `/api/atlas/areas` | `category`, `bbox` | Committed area JSON; bbox filters area centres, not polygon intersection |
| `/api/atlas/corridors` | none | Six committed corridor descriptors |
| `/api/atlas/districts` | none | Static Worker list with rounded figures; not live administrative data |
| `/api/atlas/at-this-point` | `lng`, `lat` | Nearest curated area and upstream-derived risk/weather/sensor context |
| `/api/atlas/transit` | `lng`, `lat`, `radius`, `limit` | Upstream metro and bus feeds; radius is kilometres, capped at 30 |
| `/api/atlas/buildings` | `bbox`, `limit` | R2 metadata and archive pointer; **no server-side building geometry query** |
| `/api/atlas/scoreboard` | none | Upstream feed status plus tile availability; some summary counts are constants |
| `/api/atlas/city-events` | none | Companion disaster brief transformed into an event response |
| `/api/risk` | `lng`, `lat`, optional `pm25` | Derived civic score, source factors and omitted inputs |
| `/api/traffic` | none | Upstream sensor and transit aggregation |
| `/api/health` | none | Worker response plus an R2 `head` availability check |

The router accepts GET/HEAD and OPTIONS; other methods return 405. The source does not strictly reject every malformed area bbox, so callers should validate bbox values themselves. The offline tests cover specific contracts, not every API/schema combination.

## Two independent data paths

1. **Tiles:** browser PMTiles reader → same-origin Worker path → `HCMC_TILES` R2 range → binary response. `run_worker_first` ensures the Worker sees tile requests before static assets. A cache-busting query does not change path routing
2. **Civic JSON:** browser → same-origin API → companion dashboard → Cloudflare Cache API. A failed upstream request yields unavailable/null source data rather than a self-contained local feed

The default client uses same-origin API paths. It sends an iframe readiness message and accepts configured parent messages only from the origin list in `public/app.js`; this list must be considered when embedding a fork.

## Provenance and limits

- Footprints and heights have different origins. The baking pipeline prefers a measured height, then floors × 3.3 m, Google satellite heights, GHSL heights, and finally class estimates. Those are not all measurements
- The current UI's production-sized building count is authored copy. Archives are absent, so that count cannot be reproduced or audited from this checkout alone
- Landmark `source` / `osm` fields are provenance metadata. Some heights are explicitly curated estimates
- District statistics are a static convenience list. Do not imply they describe the current official administrative boundaries
- Risk is application logic; missing factors and data freshness affect meaning. It is not a certified safety assessment
- Code, tile-data attribution, and third-party service terms are separate. A metadata `license` field in one JSON file is not a repository-wide license
