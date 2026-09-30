// Cloudflare Worker entry for hcmc-3d-atlas.
//
// The atlas itself is a static SPA in public/ (no build step). The Worker
// exists to (1) host the custom domain, (2) pass HTTP Range through to
// R2 for the PMTiles buildings archive (Workers [assets] binding does
// NOT honor Range — every GET would return the full 17 MB blob, defeating
// the whole point of PMTiles), and (3) answer the AI-readable mirror at
// /api/atlas/* — the same shape that bkk-3d-atlas exposes for Bangkok.
//
// Six /api/atlas/* endpoints answer the questions an LLM agent, a research
// script, or a future MCP server would actually ask the city:
//
//   /api/atlas/areas?bbox=&category=        → the 12 curated areas
//   /api/atlas/districts                    → quận/huyện joined to land/flood
//   /api/atlas/at-this-point?lng=&lat=      → "click the city"
//   /api/atlas/transit?lng=&lat=&radius=    → nearest metro/pier/transit
//   /api/atlas/buildings?bbox=&limit=      → honest pointer to PMTiles
//   /api/atlas/scoreboard                   → live feed health
//   /api/atlas/city-events                  → live breaking incidents
//   /api/atlas/corridors                    → the six governor corridors
//   /api/risk                                → flood × PM2.5 civic score
//   /api/traffic                             → live VNTT sensor / metro / bus
//
// Why R2 for PMTiles: the same reason as bkk-3d-atlas — Range + ETag are
// how pmtiles.js streams by tile. Without the Worker, every request to
// /hcmc-buildings.pmtiles returns the full archive.

export interface Env {
  ASSETS: Fetcher;
  HCMC_TILES: R2Bucket;
}

const PMTILES_PATH = "/hcmc-buildings.pmtiles";
const PMTILES_R2_KEY = "buildings/hcmc.pmtiles";
const WATERWAYS_PMTILES_PATH = "/hcmc-waterways.pmtiles";
const WATERWAYS_PMTILES_R2_KEY = "buildings/hcmc-waterways.pmtiles";
const HERITAGE_PMTILES_PATH = "/hcmc-buildings-cbd.pmtiles";
const HERITAGE_PMTILES_R2_KEY = "buildings/hcmc-cbd.pmtiles";

const ATLAS_VERSION = "0.1.0";

// Greater HCMC bbox (incl. Thủ Đức, Bình Chánh, Nhà Bè, Cần Giờ)
const HCMC_BBOX = {
  minLat: 10.35,
  maxLat: 11.20,
  minLon: 106.30,
  maxLon: 107.05,
} as const;

// TTL for cached live upstream responses
const SENSOR_CACHE_TTL_SECONDS = 60;
const EVENTS_CACHE_TTL_SECONDS = 300;
const RISK_CACHE_TTL_SECONDS = 3600;

/** HCMC traffic band colour borrowed from the operations dashboard. */
const TRAFFIC_BAND_COLOR: Record<string, string> = {
  clear:   "#22c55e",
  light:   "#86efac",
  moderate:"#f59e0b",
  heavy:   "#f97316",
  severe:  "#ef4444",
  unknown: "#6b7280",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "public, max-age=60");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

function applyTileCors(headers: Headers) {
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "access-control-expose-headers",
    "Accept-Ranges, Content-Length, Content-Range, ETag",
  );
  // Vary on Range so Cloudflare's edge does NOT cache the first 200 OK
  // response and serve it back on subsequent Range requests. Without this,
  // pmtiles.js's first header-range GET gets a 206 with content-length 128,
  // then the next full-file GET (or any other Range) hits the cached 200
  // and the library throws "Server returned no content-length header or
  // content-length exceeding request".
  headers.append("vary", "Range");
}

// ── PMTiles Range passthrough ─────────────────────────────────────────────

function parseRange(header: string | null):
  | { offset: number; length?: number }
  | { offset: number; length: number; suffix: true }
  | null {
  if (!header) return null;
  const match = /^bytes=(-)?(\d+)(?:-(\d*))?$/.exec(header.trim());
  if (!match) return null;
  if (match[1] === "-") {
    const suffix = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { offset: 0, length: suffix, suffix: true };
  }
  const offset = Number.parseInt(match[2], 10);
  if (!Number.isFinite(offset) || offset < 0) return null;
  if (match[3] === undefined || match[3] === "") return { offset };
  const end = Number.parseInt(match[3], 10);
  if (!Number.isFinite(end) || end < offset) return null;
  return { offset, length: end - offset + 1 };
}

async function servePmtilesFromR2(request: Request, env: Env, key: string): Promise<Response> {
  const range = parseRange(request.headers.get("range"));
  if (range && "suffix" in range && range.suffix) {
    const head = await env.HCMC_TILES.head(key);
    if (head === null) return new Response("not found", { status: 404 });
    const suffixLen = range.length ?? 0;
    const length = Math.min(suffixLen, head.size);
    const offset = head.size - length;
    return streamRange(env, key, offset, length, head.size);
  }
  if (range) {
    // Validate the requested range against the actual object size BEFORE
    // hitting R2 -- R2 throws Error 10039 "The requested range is not
    // satisfiable" which manifests as a Worker 500 and trips pmtiles.js.
    const head = await env.HCMC_TILES.head(key);
    if (head === null) return new Response("not found", { status: 404 });
    const requestedEnd = range.offset + (range.length ?? (head.size - range.offset)) - 1;
    if (range.offset >= head.size) {
      // Proper HTTP 416 Range Not Satisfiable, pmtiles.js handles this.
      const h = new Headers();
      h.set("content-range", `bytes */${head.size}`);
      h.set("accept-ranges", "bytes");
      applyTileCors(h);
      return new Response(null, { status: 416, headers: h });
    }
    if (requestedEnd >= head.size) {
      // Clamp the read to the actual file end rather than blowing up. This
      // is what S3 / R2 do internally too -- pmtiles.js accepts the
      // truncated read as long as content-length matches.
      range.length = head.size - range.offset;
    }
    return streamRange(env, key, range.offset, range.length ?? (head.size - range.offset), head.size);
  }
  const obj = await env.HCMC_TILES.get(key);
  if (obj === null) return new Response("not found", { status: 404 });
  if (!("body" in obj) || obj.body === null) return new Response(null, { status: 304 });
  const headers = new Headers();
  headers.set("content-type", "application/octet-stream");
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  applyTileCors(headers);
  if (obj.httpEtag) headers.set("etag", obj.httpEtag);
  headers.set("x-hcmcx-source", `R2 hcmc-tiles/${key}`);
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

async function streamRange(env: Env, key: string, offset: number, length: number, totalSize: number): Promise<Response> {
  const obj = await env.HCMC_TILES.get(key, { range: { offset, length } });
  if (obj === null || !("body" in obj) || obj.body === null) {
    return new Response(null, { status: 304 });
  }
  const headers = new Headers();
  headers.set("content-type", "application/octet-stream");
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  applyTileCors(headers);
  if (obj.httpEtag) headers.set("etag", obj.httpEtag);
  headers.set("x-hcmcx-source", `R2 hcmc-tiles/${key}`);
  headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${totalSize}`);
  headers.set("content-length", String(length));
  return new Response(obj.body, { status: 206, headers });
}

// ── HCMC harness ──────────────────────────────────────────────────────────

function parseHcmcLngLat(request: Request): { lng: number; lat: number } | Response {
  const url = new URL(request.url);
  const lng = Number.parseFloat(url.searchParams.get("lng") ?? "");
  const lat = Number.parseFloat(url.searchParams.get("lat") ?? "");
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return jsonResponse(
      {
        error: "invalid_coordinates",
        message: "Pass ?lng=&lat= as WGS84 decimals (HCMC ≈ 106.7, 10.78).",
      },
      { status: 400 },
    );
  }
  if (
    lng < HCMC_BBOX.minLon || lng > HCMC_BBOX.maxLon ||
    lat < HCMC_BBOX.minLat || lat > HCMC_BBOX.maxLat
  ) {
    return jsonResponse(
      {
        error: "out_of_hcmc_bbox",
        message: "Coordinates fall outside the HCMC metro bbox used by this atlas.",
        lng,
        lat,
      },
      { status: 400 },
    );
  }
  return { lng, lat };
}

// ── Static assets ─────────────────────────────────────────────────────────

interface HcmcArea {
  id: string;
  name: string;
  vietnamese: string;
  category: string;
  chapter: string;
  description: string;
  center: [number, number];
  zoom: number;
  pitch?: number;
  bearing?: number;
  keyStats?: Record<string, string | number>;
  tags?: string[];
}

interface HcmcAreasDoc {
  name: string;
  version: string;
  license: string;
  projection: string;
  areas: HcmcArea[];
  categories: Record<string, string>;
  corridors: Array<{ id: string; name: string; vietnamese: string; color: string }>;
}

let areasCache: HcmcAreasDoc | null = null;

async function loadAreas(env: Env, request: Request): Promise<HcmcAreasDoc | null> {
  if (areasCache) return areasCache;
  const url = new URL("/hcmc-areas.json", request.url);
  const res = await env.ASSETS.fetch(new Request(url.toString(), request));
  if (!res.ok) return null;
  const doc = (await res.json()) as HcmcAreasDoc;
  if (Array.isArray(doc?.areas) && doc.areas.length > 0) {
    areasCache = doc;
    return areasCache;
  }
  return null;
}

// ── Live data feeds (proxy through to the HCMC dashboard API) ─────────────

const HCMC_DASHBOARD_BASE = "https://hcmc.nonarkara.org";

interface Provenance {
  tier?: string;
  source?: string;
  fetchedAt?: string;
  observedAt?: string;
  note?: string;
  scenario?: string;
}

interface SensorReading {
  sensorId?: string;
  observedAt?: string;
  value?: number;
  status?: string;
}

interface SensorRow {
  id?: string;
  lat?: number;
  lon?: number;
  lng?: number;
  status?: string;
  latestReading?: SensorReading;
}

interface SensorFeed {
  readings?: SensorRow[];
  sensors?: SensorRow[];
  sourceSummary?: { mode?: string; freshness?: { observedAt?: string | null } };
  provenance?: Provenance;
  generatedAt?: string;
}

interface VehicleFeed {
  trains?: Array<Record<string, unknown>>;
  buses?: Array<Record<string, unknown>>;
  positions?: Array<Record<string, unknown>>;
  scenario?: string;
  generatedAt?: string;
  provenance?: Provenance;
}

interface AqiStation {
  label?: string;
  lat?: number;
  lng?: number;
  aqi?: number;
  pm25?: number;
  observedAt?: string;
  provenance?: Provenance;
}

interface WeatherOps {
  rainfallMm?: number | null;
  windKph?: number | null;
  condition?: string;
  status?: string;
  sourceSummary?: { mode?: string; freshness?: { observedAt?: string | null } };
  provenance?: Provenance;
}

const UPSTREAM_PATHS = [
  "/api/hcmc/sensors",
  "/api/air-quality",
  "/api/weather/ops",
  "/api/disaster/brief",
  "/api/hcmc/transit/metro",
  "/api/hcmc/transit/buses",
] as const;

async function fetchHcmcJson<T>(path: string, ttlSeconds = 60): Promise<T | null> {
  const upstream = `${HCMC_DASHBOARD_BASE}${path}`;
  const cacheKey = new Request(upstream, { method: "GET" });
  const edgeCache = (caches as unknown as { default: Cache }).default;
  try {
    const hit = await edgeCache.match(cacheKey);
    if (hit) return (await hit.json()) as T;
  } catch {
    // Cache API miss is not a data miss. Fall through to the network.
  }
  try {
    const res = await fetch(upstream, {
      headers: { "user-agent": "HcmcAtlas/0.1 (+https://hcmc-3d-atlas.drnon.workers.dev)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as T;
    try {
      await edgeCache.put(
        cacheKey,
        new Response(JSON.stringify(data), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${ttlSeconds}`,
          },
        }),
      );
    } catch {
      // A cache write failure still leaves the caller with the live body.
    }
    return data;
  } catch {
    return null;
  }
}

function sensorRows(feed: SensorFeed | null): SensorRow[] {
  if (!feed) return [];
  return feed.sensors ?? feed.readings ?? [];
}

function sensorStatus(row: SensorRow): string {
  return row.latestReading?.status ?? row.status ?? "unknown";
}

function sensorObservedAt(feed: SensorFeed | null, rows: SensorRow[]): string | null {
  let newest = 0;
  let iso: string | null = null;
  for (const row of rows) {
    const stamp = row.latestReading?.observedAt;
    const t = stamp ? Date.parse(stamp) : Number.NaN;
    if (Number.isFinite(t) && t > newest) {
      newest = t;
      iso = stamp ?? null;
    }
  }
  return iso
    ?? feed?.sourceSummary?.freshness?.observedAt
    ?? feed?.provenance?.observedAt
    ?? feed?.generatedAt
    ?? null;
}

function sensorFeedStale(feed: SensorFeed | null, rows: SensorRow[]): boolean {
  if (!feed) return true;
  if (/stale/i.test(feed.provenance?.note ?? "")) return true;
  const observed = sensorObservedAt(feed, rows);
  const t = observed ? Date.parse(observed) : Number.NaN;
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > 6 * 60 * 60 * 1000;
}

function vehicleLng(row: Record<string, unknown>): number {
  const n = row.lng ?? row.lon;
  return typeof n === "number" ? n : Number(n);
}

function vehicleLat(row: Record<string, unknown>): number {
  return typeof row.lat === "number" ? row.lat : Number(row.lat);
}

function vehicleRows(feed: VehicleFeed | null, kind: "metro" | "bus"): Array<Record<string, unknown>> {
  if (!feed) return [];
  if (kind === "metro") return feed.trains ?? [];
  return feed.positions ?? feed.buses ?? [];
}

interface RiskReport {
  score: number;
  band: "high" | "elevated" | "low";
  factors: Record<string, unknown>;
  weather: {
    condition: string;
    rainfallMm: number | null;
    windKph: number | null;
    mode: string;
    status: string | null;
  };
  sensors: {
    total: number;
    alert: number;
    warning: number;
    observedAt: string | null;
    tier: string | null;
    stale: boolean;
    note: string | null;
  };
  omitted: string[];
}

function riskBand(score: number): RiskReport["band"] {
  if (score >= 70) return "high";
  if (score >= 40) return "elevated";
  return "low";
}

async function assessRisk(lng: number, lat: number, pm25Override: number | null): Promise<RiskReport> {
  const [stations, weather, sensors] = await Promise.all([
    fetchHcmcJson<AqiStation[]>("/api/air-quality", 300),
    fetchHcmcJson<WeatherOps>("/api/weather/ops", 60),
    fetchHcmcJson<SensorFeed>("/api/hcmc/sensors", 60),
  ]);

  let station: AqiStation | null = null;
  if (Array.isArray(stations)) {
    let bestD = Infinity;
    for (const s of stations) {
      const slng = Number(s.lng);
      const slat = Number(s.lat);
      if (!Number.isFinite(slng) || !Number.isFinite(slat)) continue;
      const d = (slng - lng) ** 2 + (slat - lat) ** 2;
      if (d < bestD) {
        bestD = d;
        station = s;
      }
    }
  }

  const overridden = pm25Override != null && Number.isFinite(pm25Override);
  const pm25 = overridden
    ? Math.min(500, Math.max(0, pm25Override as number))
    : (typeof station?.pm25 === "number" && Number.isFinite(station.pm25) ? station.pm25 : null);
  const aqiFactor = pm25 == null ? 0 : Math.min(1, Math.max(0, (pm25 - 12) / 138));

  const rows = sensorRows(sensors);
  const stale = sensorFeedStale(sensors, rows);
  const alertCount = rows.filter((r) => sensorStatus(r) === "alert").length;
  const warningCount = rows.filter((r) => sensorStatus(r) === "warning").length;
  const floodFactor = stale ? null : Math.min(1, alertCount / 6);
  const rainMm = typeof weather?.rainfallMm === "number" && Number.isFinite(weather.rainfallMm)
    ? weather.rainfallMm
    : null;
  // 50 mm saturates the water term. Used only when the sensor feed is too old to count.
  const rainFactor = rainMm == null ? null : Math.min(1, Math.max(0, rainMm) / 50);
  const waterFactor = floodFactor ?? rainFactor ?? 0;
  const waterFrom = floodFactor != null ? "sensors" : rainFactor != null ? "rainfall" : "none";
  const windKph = typeof weather?.windKph === "number" && Number.isFinite(weather.windKph)
    ? weather.windKph
    : null;
  const windFactor = (windKph ?? 0) >= 25 ? 0.4 : 0;
  const omitted = waterFrom === "none" ? ["flood"] : [];
  const score = Math.round(100 * (0.45 * waterFactor + 0.4 * aqiFactor + 0.15 * windFactor));

  return {
    score,
    band: riskBand(score),
    omitted,
    factors: {
      floodAlerts: alertCount,
      floodFactor: floodFactor == null ? null : Math.round(floodFactor * 100) / 100,
      floodOmitted: waterFrom === "none",
      waterFrom,
      rainfallMm: rainMm,
      rainFactor: rainFactor == null ? null : Math.round(rainFactor * 100) / 100,
      pm25,
      pm25Overridden: overridden,
      pm25Station: station?.label ?? null,
      pm25ObservedAt: station?.observedAt ?? station?.provenance?.fetchedAt ?? null,
      pm25Tier: overridden ? "query-override" : (station?.provenance?.tier ?? null),
      pm25Source: station?.provenance?.source ?? null,
      aqiFactor: Math.round(aqiFactor * 100) / 100,
      windFactor,
      windKph,
    },
    weather: {
      condition: weather?.condition ?? "unknown",
      rainfallMm: weather?.rainfallMm ?? null,
      windKph,
      mode: weather?.sourceSummary?.mode ?? "unknown",
      status: weather?.status ?? null,
    },
    sensors: {
      total: rows.length,
      alert: alertCount,
      warning: warningCount,
      observedAt: sensorObservedAt(sensors, rows),
      tier: sensors?.provenance?.tier ?? sensors?.sourceSummary?.mode ?? null,
      stale,
      note: sensors?.provenance?.note ?? null,
    },
  };
}

// ── /api/atlas/* handlers ─────────────────────────────────────────────────

async function handleAreas(request: Request, env: Env): Promise<Response> {
  const doc = await loadAreas(env, request);
  if (!doc) {
    return jsonResponse({ error: "areas_unavailable" }, { status: 503 });
  }
  const url = new URL(request.url);
  const bboxParam = url.searchParams.get("bbox");
  const category = url.searchParams.get("category");
  let areas = doc.areas;
  if (category) areas = areas.filter((a) => a.category === category);
  if (bboxParam) {
    const parts = bboxParam.split(",").map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      const [w, s, e, n] = parts;
      areas = areas.filter((a) => a.center[0] >= w && a.center[0] <= e && a.center[1] >= s && a.center[1] <= n);
    }
  }
  return jsonResponse({
    tool: "atlas.areas",
    version: ATLAS_VERSION,
    count: areas.length,
    areas,
    corridors: doc.corridors,
    categories: doc.categories,
    source: "hcmc-3d-atlas/hcmc-areas.json",
  });
}

async function handleCorridors(request: Request, env: Env): Promise<Response> {
  const doc = await loadAreas(env, request);
  if (!doc) return jsonResponse({ error: "corridors_unavailable" }, { status: 503 });
  return jsonResponse({
    tool: "atlas.corridors",
    version: ATLAS_VERSION,
    corridors: doc.corridors,
  });
}

async function handleDistricts(): Promise<Response> {
  // HCMC has 24 districts total — 19 inner + 5 outer.
  // The shape mirrors bkk-3d-atlas: id, nameEn, nameVi, centroid, population,
  // areaKm2. Without a real source, we fall back to the curated list.
  const districts = [
    { id: "d1",   nameEn: "District 1",          nameVi: "Quận 1",          centroid: [106.7009, 10.775],  areaKm2: 7.74,  population: 205860 },
    { id: "d3",   nameEn: "District 3",          nameVi: "Quận 3",          centroid: [106.6830, 10.783],  areaKm2: 4.97,  population: 192280 },
    { id: "d4",   nameEn: "District 4",          nameVi: "Quận 4",          centroid: [106.7050, 10.762],  areaKm2: 4.18,  population: 184620 },
    { id: "d5",   nameEn: "District 5",          nameVi: "Quận 5",          centroid: [106.6680, 10.762],  areaKm2: 4.27,  population: 174640 },
    { id: "d6",   nameEn: "District 6",          nameVi: "Quận 6",          centroid: [106.6400, 10.751],  areaKm2: 7.16,  population: 253780 },
    { id: "d7",   nameEn: "District 7 (PMH)",    nameVi: "Quận 7 (PMH)",    centroid: [106.7228, 10.738],  areaKm2: 35.97, population: 360150 },
    { id: "d8",   nameEn: "District 8",          nameVi: "Quận 8",          centroid: [106.6500, 10.730],  areaKm2: 19.49, population: 451310 },
    { id: "d10",  nameEn: "District 10",         nameVi: "Quận 10",         centroid: [106.6680, 10.776],  areaKm2: 5.79,  population: 234820 },
    { id: "d11",  nameEn: "District 11",         nameVi: "Quận 11",         centroid: [106.6430, 10.764],  areaKm2: 5.55,  population: 211580 },
    { id: "d12",  nameEn: "District 12",         nameVi: "Quận 12",         centroid: [106.6400, 10.812],  areaKm2: 52.78, population: 620100 },
    { id: "tb",   nameEn: "Bình Thạnh",          nameVi: "Bình Thạnh",      centroid: [106.7117, 10.802],  areaKm2: 20.78, population: 528730 },
    { id: "gd",   nameEn: "Gò Vấp",             nameVi: "Gò Vấp",          centroid: [106.6500, 10.832],  areaKm2: 19.74, population: 676680 },
    { id: "pn",   nameEn: "Phú Nhuận",           nameVi: "Phú Nhuận",       centroid: [106.6790, 10.795],  areaKm2: 4.88,  population: 174580 },
    { id: "td",   nameEn: "Tân Bình",            nameVi: "Tân Bình",        centroid: [106.6519, 10.808],  areaKm2: 22.43, population: 478200 },
    { id: "tp",   nameEn: "Tân Phú",             nameVi: "Tân Phú",         centroid: [106.6300, 10.795],  areaKm2: 16.06, population: 511140 },
    { id: "bt",   nameEn: "Bình Tân",            nameVi: "Bình Tân",        centroid: [106.6038, 10.765],  areaKm2: 51.93, population: 738100 },
    { id: "tdt",  nameEn: "Thủ Đức (city)",      nameVi: "TP. Thủ Đức",     centroid: [106.7537, 10.850],  areaKm2: 211.56,population: 1218180 },
    { id: "bc",   nameEn: "Bình Chánh",          nameVi: "Bình Chánh",      centroid: [106.5900, 10.660],  areaKm2: 252.69,population: 642940 },
    { id: "nb",   nameEn: "Nhà Bè",              nameVi: "Nhà Bè",          centroid: [106.7330, 10.696],  areaKm2: 100.43,population: 416640 },
    { id: "cg",   nameEn: "Cần Giờ",             nameVi: "Cần Giờ",         centroid: [106.9500, 10.410],  areaKm2: 704.22,population: 121560 },
    { id: "hcmc", nameEn: "Ho Chi Minh City",    nameVi: "TP. Hồ Chí Minh", centroid: [106.7009, 10.775],  areaKm2: 2095.4,population: 9420000 },
  ];
  return jsonResponse({
    tool: "atlas.districts",
    version: ATLAS_VERSION,
    count: districts.length,
    districts,
    source: {
      name: "curated static list in the worker",
      tier: "static",
      note: "District names and rounded figures. Not a live General Statistics Office pull.",
    },
  });
}

async function handleAtThisPoint(request: Request, env: Env): Promise<Response> {
  const parsed = parseHcmcLngLat(request);
  if (parsed instanceof Response) return parsed;
  const { lng, lat } = parsed;

  // Find nearest curated area (excluding city-scale / infrastructure entries
  // so a click downtown doesn't return "Ho Chi Minh City from above" when
  // it could equally resolve to District 1).
  const doc = await loadAreas(env, request);
  let nearest: HcmcArea | null = null;
  let best = Infinity;
  if (doc) {
    const SKIP_CATEGORIES = new Set(["city-scale", "infrastructure"]);
    for (const a of doc.areas) {
      if (SKIP_CATEGORIES.has(a.category)) continue;
      const d = (a.center[0] - lng) ** 2 + (a.center[1] - lat) ** 2;
      if (d < best) { best = d; nearest = a; }
    }
    // Fallback: if the click is far from any specific area, fall back to
    // the first city-scale area so the response is never null.
    if (!nearest) {
      for (const a of doc.areas) {
        const d = (a.center[0] - lng) ** 2 + (a.center[1] - lat) ** 2;
        if (d < best) { best = d; nearest = a; }
      }
    }
  }

  const risk = await assessRisk(lng, lat, null);

  return jsonResponse({
    tool: "atlas.at-this-point",
    version: ATLAS_VERSION,
    query: { lng, lat },
    location: {
      nearestArea: nearest
        ? { id: nearest.id, name: nearest.name, vietnamese: nearest.vietnamese, distanceKm: Math.sqrt(best) * 111 }
        : null,
    },
    weather: risk.weather,
    sensors: risk.sensors,
    risk: {
      score: risk.score,
      band: risk.band,
      omitted: risk.omitted,
      factors: risk.factors,
    },
    fetchedAt: new Date().toISOString(),
  });
}

async function handleTransit(request: Request): Promise<Response> {
  const parsed = parseHcmcLngLat(request);
  if (parsed instanceof Response) return parsed;
  const { lng, lat } = parsed;
  const url = new URL(request.url);
  const radiusParam = Number.parseFloat(url.searchParams.get("radius") ?? "2");
  const radius = Number.isFinite(radiusParam) && radiusParam > 0 ? Math.min(radiusParam, 30) : 2;
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "5", 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 20) : 5;

  // Dashboard payloads use `lon` and `positions`, not `lng` and `buses`.
  const [metro, buses] = await Promise.all([
    fetchHcmcJson<VehicleFeed>("/api/hcmc/transit/metro", 30),
    fetchHcmcJson<VehicleFeed>("/api/hcmc/transit/buses", 30),
  ]);

  const nearby = (rows: Array<Record<string, unknown>>, kind: string) =>
    rows
      .map((p) => {
        const plat = vehicleLat(p);
        const plng = vehicleLng(p);
        return {
          kind,
          id: p.id ?? null,
          lat: plat,
          lng: plng,
          distanceKm: Math.hypot(plng - lng, plat - lat) * 111,
          line: p.line ?? p.lineId ?? null,
          route: p.route ?? p.routeId ?? p.routeName ?? null,
          corridorId: p.corridorId ?? null,
          speedKmh: p.speedKmh ?? p.speedKph ?? null,
          status: p.status ?? null,
        };
      })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.distanceKm <= radius)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, limit);

  const metroNearby = nearby(vehicleRows(metro, "metro"), "metro");
  const busNearby = nearby(vehicleRows(buses, "bus"), "bus");

  return jsonResponse({
    tool: "atlas.transit",
    version: ATLAS_VERSION,
    query: { lng, lat, radiusKm: radius },
    transit: [...metroNearby, ...busNearby].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit),
    provenance: {
      metro: metro?.provenance ?? null,
      buses: buses?.provenance ?? null,
    },
  });
}

async function handleBuildings(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const bboxParam = url.searchParams.get("bbox");
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "1000", 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 5000) : 1000;
  const head = await env.HCMC_TILES.head(PMTILES_R2_KEY).catch(() => null);
  const sizeMb = head ? head.size / (1024 * 1024) : null;
  return jsonResponse({
    tool: "atlas.buildings",
    version: ATLAS_VERSION,
    bbox: bboxParam,
    limit,
    pointer: {
      pmtiles: PMTILES_PATH,
      r2Key: PMTILES_R2_KEY,
      sizeMb,
      heritagePointer: HERITAGE_PMTILES_PATH,
    },
    note: "Honest pointer — bbox server-side query isn't wired yet; load the PMTiles in MapLibre via the pmtiles:// protocol and filter client-side.",
  });
}

async function handleScoreboard(env: Env, request: Request): Promise<Response> {
  const ops = await fetchHcmcJson<{
    provenance?: { tier: string; mode: string };
    airportDemand?: { status: string };
    weatherConstraint?: { status: string };
    cityTransferSupply?: { status: string };
    marineConstraint?: { status: string };
  }>("/api/operations/dashboard");
  const sensors = await fetchHcmcJson<SensorFeed>("/api/hcmc/sensors", 60);
  const weather = await fetchHcmcJson<{
    sourceSummary?: { mode: string; freshness?: { observedAt: string | null } };
  }>("/api/weather/ops");
  const cameras = await fetchHcmcJson<{ verifiedLiveCount?: number }>(
    "/api/public-cameras",
  );
  const flights = await fetchHcmcJson<{ mode: string }>(
    "/api/flights/arrivals",
  );
  const news = await fetchHcmcJson<{ news?: unknown[] }>("/api/news");
  const tileHead = await env.HCMC_TILES.head(PMTILES_R2_KEY).catch(() => null);

  return jsonResponse({
    tool: "atlas.scoreboard",
    version: ATLAS_VERSION,
    feeds: {
      operations: ops?.provenance?.mode ?? "unknown",
      sensors: sensors?.provenance?.tier ?? sensors?.sourceSummary?.mode ?? "unknown",
      weather: weather?.sourceSummary?.mode ?? "unknown",
      cameras: cameras?.verifiedLiveCount ?? 0,
      flights: flights?.mode ?? "unknown",
      news: Array.isArray(news?.news) ? news.news.length : 0,
    },
    districts: 21,
    corridors: 6,
    railways: 1,
    pmtiles: {
      buildings: PMTILES_PATH,
      sizeMb: tileHead ? tileHead.size / (1024 * 1024) : null,
    },
    sensorNote: sensors?.provenance?.note ?? null,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleCityEvents(): Promise<Response> {
  // Lightweight passthrough: the dashboard's own /api/disaster/brief gives us
  // a curated set of source-attributed breaking incidents. We forward and tag it.
  const disaster = await fetchHcmcJson<{
    generatedAt?: string;
    incidents?: Array<{
      id: string;
      title: string;
      category: string;
      severity: string;
      lng?: number;
      lat?: number;
      source?: string;
      publishedAt?: string;
      description?: string;
    }>;
  }>("/api/disaster/brief");

  const incidents = disaster?.incidents ?? [];
  const inBbox = (lng?: number, lat?: number) =>
    lng != null && lat != null &&
    lng >= HCMC_BBOX.minLon && lng <= HCMC_BBOX.maxLon &&
    lat >= HCMC_BBOX.minLat && lat <= HCMC_BBOX.maxLat;

  const features = incidents
    .filter((i) => inBbox(i.lng, i.lat))
    .map((i) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [i.lng!, i.lat!] },
      properties: {
        id: i.id,
        title: i.title,
        category: i.category,
        severity: i.severity,
        source: i.source,
        publishedAt: i.publishedAt,
        description: i.description,
      },
    }));

  return jsonResponse({
    tool: "atlas.city-events",
    version: ATLAS_VERSION,
    count: features.length,
    ttlMinutes: 60,
    features: { type: "FeatureCollection", features },
    fetchedAt: disaster?.generatedAt ?? new Date().toISOString(),
    ingestWarning: incidents.length === 0 ? "No breaking incidents in the HCMC bbox right now." : undefined,
  });
}

// ── /api/risk (mirrors bkk-3d-atlas) ───────────────────────────────────────

async function handleRisk(request: Request): Promise<Response> {
  const parsed = parseHcmcLngLat(request);
  if (parsed instanceof Response) return parsed;
  const { lng, lat } = parsed;
  const url = new URL(request.url);
  const pm25Override = Number.parseFloat(url.searchParams.get("pm25") ?? "");
  const risk = await assessRisk(lng, lat, Number.isFinite(pm25Override) ? pm25Override : null);

  return jsonResponse({
    tool: "risk",
    version: ATLAS_VERSION,
    query: { lng, lat },
    score: risk.score,
    band: risk.band,
    omitted: risk.omitted,
    factors: risk.factors,
    sensors: risk.sensors,
    disclaimer:
      "Civic demo score. Water is rainfall while the sensor feed is stale, otherwise flood alerts. PM2.5 is the nearest station. Not for insurance underwriting or official planning.",
  }, { headers: { "cache-control": `public, max-age=${RISK_CACHE_TTL_SECONDS}` } });
}

// ── /api/traffic passthrough (live sensors, metro, buses) ─────────────────

function publicVehicle(row: Record<string, unknown>) {
  return {
    id: row.id ?? null,
    lat: vehicleLat(row),
    lng: vehicleLng(row),
    line: row.line ?? row.lineId ?? null,
    route: row.route ?? row.routeId ?? row.routeName ?? null,
    corridorId: row.corridorId ?? null,
    speedKmh: row.speedKmh ?? row.speedKph ?? null,
    status: row.status ?? null,
  };
}

async function handleTraffic(): Promise<Response> {
  const [sensors, metro, buses, cameras] = await Promise.all([
    fetchHcmcJson<SensorFeed>("/api/hcmc/sensors", 60),
    fetchHcmcJson<VehicleFeed>("/api/hcmc/transit/metro", 30),
    fetchHcmcJson<VehicleFeed>("/api/hcmc/transit/buses", 30),
    fetchHcmcJson<{
      verifiedLiveCount: number;
      expectedVerifiedFeeds: number;
    }>("/api/public-cameras", 60),
  ]);
  const rows = sensorRows(sensors);

  return jsonResponse({
    tool: "traffic",
    version: ATLAS_VERSION,
    sensors: rows.map((row) => ({
      id: row.id ?? row.latestReading?.sensorId ?? null,
      lat: row.lat ?? null,
      lng: row.lng ?? row.lon ?? null,
      status: sensorStatus(row),
      observedAt: row.latestReading?.observedAt ?? null,
      value: row.latestReading?.value ?? null,
    })),
    metro: vehicleRows(metro, "metro").map(publicVehicle),
    buses: vehicleRows(buses, "bus").map(publicVehicle),
    cameras: cameras ?? { verifiedLiveCount: 0, expectedVerifiedFeeds: 0 },
    provenance: {
      sensors: sensors?.provenance ?? null,
      metro: metro?.provenance ?? null,
      buses: buses?.provenance ?? null,
    },
    fetchedAt: new Date().toISOString(),
  }, { headers: { "cache-control": `public, max-age=${SENSOR_CACHE_TTL_SECONDS}` } });
}

// ── /api/health — quick liveness probe ────────────────────────────────────

async function handleHealth(env: Env): Promise<Response> {
  const head = await env.HCMC_TILES.head(PMTILES_R2_KEY).catch(() => null);
  return jsonResponse({
    tool: "health",
    version: ATLAS_VERSION,
    ok: true,
    pmtiles: head
      ? { available: true, sizeMb: head.size / (1024 * 1024) }
      : { available: false, sizeMb: null },
    bbox: HCMC_BBOX,
    uptime: Date.now(),
  });
}

// ── Router ────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight short-circuit
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "content-type, range",
          "access-control-expose-headers": "Accept-Ranges, Content-Length, Content-Range, ETag",
          "access-control-max-age": "86400",
        },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", {
        status: 405,
        headers: {
          allow: "GET, HEAD, OPTIONS",
          "access-control-allow-origin": "*",
        },
      });
    }

    // PMTiles Range passthrough (the whole reason this Worker exists)
    // pmtiles.js appends `?v=...` cache busters to the source URL, so we
    // route by the pathname only (not the full URL with query).
    if (path === PMTILES_PATH) return servePmtilesFromR2(request, env, PMTILES_R2_KEY);
    if (path === WATERWAYS_PMTILES_PATH) return servePmtilesFromR2(request, env, WATERWAYS_PMTILES_R2_KEY);
    if (path === HERITAGE_PMTILES_PATH) return servePmtilesFromR2(request, env, HERITAGE_PMTILES_R2_KEY);

    // Atlas AI-mirror
    if (path === "/api/atlas/areas") return handleAreas(request, env);
    if (path === "/api/atlas/corridors") return handleCorridors(request, env);
    if (path === "/api/atlas/districts") return handleDistricts();
    if (path === "/api/atlas/at-this-point") return handleAtThisPoint(request, env);
    if (path === "/api/atlas/transit") return handleTransit(request);
    if (path === "/api/atlas/buildings") return handleBuildings(request, env);
    if (path === "/api/atlas/scoreboard") return handleScoreboard(env, request);
    if (path === "/api/atlas/city-events") return handleCityEvents();

    // Civic APIs
    if (path === "/api/risk") return handleRisk(request);
    if (path === "/api/traffic") return handleTraffic();
    if (path === "/api/health") return handleHealth(env);

    // Everything else → static SPA + assets
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("access-control-allow-origin", "*");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },

  // Warm the upstream cache the API routes actually read. The in-isolate
  // object this used to call never stored anything, so the cron was a no-op.
  async scheduled(_event: ScheduledEvent, _env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all(UPSTREAM_PATHS.map((path) => fetchHcmcJson(path, 60))).then(() => undefined));
  },
};
