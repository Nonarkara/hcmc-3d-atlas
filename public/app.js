// HCMCx 3D Atlas -- full MapLibre client.
//
// Loads curated areas, renders the city in 3D, lets the operator click
// any building for its height provenance, and overlays sensors / metro /
// buses proxied from hcmc.nonarkara.org. Same shape as bkk-3d-atlas.app.js
// but with the HCMC governor-corridor areas and PMTiles-backed buildings,
// waterways, metro line 1, and 14 stations.

// loader.js imports the pinned MapLibre module before this client.
// PMTiles uses its pinned UMD global.
const __maplibregl__ = window.maplibregl;
const __pmtiles__ = window.pmtiles;

if (!__maplibregl__ || !__pmtiles__) {
  const el = document.getElementById("atlas-map-loading");
  if (el) {
    el.innerHTML =
      '<div class="atlas-map-loading-inner">' +
      '<span class="atlas-map-loading-glyph">Hx</span>' +
      '<p class="atlas-map-loading-line">MapLibre failed to load</p>' +
      '<p class="atlas-map-loading-sub">Map libraries are unavailable. Reload to retry, or use Data &amp; sources below.</p>' +
      "</div>";
  }
  console.error("maplibregl/pmtiles not on window -- script order issue");
}

const ATLAS_BASE = ""; // same origin
const HCMC_CENTER = [106.7009, 10.775];

const ESRI_IMAGERY =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

const $ = function (sel, root) {
  return (root || document).querySelector(sel);
};
const $$ = function (sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
};

// ── State ──────────────────────────────────────────────────────────────────
let areasDoc = null;
let liveSensors = { readings: [] };
let liveCameras = [];
let mapInstance = null;
// Build tag sent to the parent dashboard in the `hcmc-atlas` ready
// postMessage. `scripts/stamp-build-id.mjs` rewrites this on every
// deploy so the dashboard can detect a stale iframe bundle.
const ATLAS_BUILD_TAG = "hcmc-atlas-20261003-1791037842-f8051c1";
// Append a build-tag query string to the PMTiles URLs so every deploy
// busts Cloudflare's edge cache. Without this, the first GET (which the
// protocol handler makes without a Range header) gets cached as 200 OK
// at the edge, and every subsequent Range request from pmtiles.js reads
// back that cached 200 with the FULL content-length -- the protocol then
// throws "Server returned no content-length header or content-length
// exceeding request" because the body is 10 MB but it only asked for 16 KB.
// pmtiles.js's Protocol() regex captures the path up to /z/x/y, so query
// strings before /z/x/y are part of the source URL and ride along on
// every Range fetch -- exactly the cache-buster we need.
const PMTILES_BUILDINGS = ATLAS_BASE + "/hcmc-buildings.pmtiles" + "?v=" + encodeURIComponent(ATLAS_BUILD_TAG);
const PMTILES_WATERWAYS = ATLAS_BASE + "/hcmc-waterways.pmtiles" + "?v=" + encodeURIComponent(ATLAS_BUILD_TAG);
let currentBasemap = "esri";
let currentAreaId = null;
let flyoverTimer = null;
let inspectFeature = null;
const liveCache = new Map();
const liveRequests = new Map();
let lastAirQuality = [];

// Interface/map materials adapt Wada 325; hazard colors retain their meaning.
const MAP_THEMES = {
  dark: { buildings: ["#88967b", "#b9bd90", "#dfcc8a", "#fbe6a0"], accent: "#e2b540", civic: "#d8b96a", opacity: 0.8, saturation: -0.45 },
  light: { buildings: ["#7d8c71", "#aeb387", "#dcc88b", "#fbe6a0"], accent: "#e2b540", civic: "#cda746", opacity: 0.65, saturation: -0.6 },
  contrast: { buildings: ["#afbaa4", "#d9dfc3", "#fbe6a0", "#fffdf2"], accent: "#ffe17a", civic: "#ffe17a", opacity: 0.45, saturation: -1 },
};
function mapTheme() { return MAP_THEMES[document.documentElement.dataset.theme] || MAP_THEMES.dark; }
function buildingThemeColor() {
  const colors = mapTheme().buildings;
  return ["interpolate", ["linear"], HEIGHT_GET, 6, colors[0], 20, colors[1], 60, colors[2], 150, colors[3]];
}
function applyMapTheme() {
  if (!mapInstance) return;
  const palette = mapTheme();
  const paints = {
    "esri-imagery": { "raster-opacity": palette.opacity, "raster-saturation": palette.saturation },
    "hcmc-buildings": { "fill-extrusion-color": ["case", ["boolean", ["feature-state", "selected"], false], palette.accent, buildingThemeColor()] },
    "hcmc-buildings-outline": { "line-color": palette.accent },
    "hcmc-landmarks-3d": { "fill-extrusion-color": ["match", ["get", "category"], "civic", palette.civic, palette.accent] },
    "hcmc-landmarks-outline": { "line-color": palette.accent },
  };
  Object.keys(paints).forEach(function (id) {
    if (!mapInstance.getLayer(id)) return;
    Object.keys(paints[id]).forEach(function (property) { mapInstance.setPaintProperty(id, property, paints[id][property]); });
  });
}
window.addEventListener("atlas:theme", applyMapTheme);

// ── Helpers ────────────────────────────────────────────────────────────────
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PARENT_ORIGINS = [
  "https://hcmc.nonarkara.org",
  "https://atlas.hcmc.nonarkara.org",
  "https://hcmc-3d-atlas.drnon.workers.dev",
];

function parentTargetOrigin() {
  try {
    if (document.referrer) {
      const origin = new URL(document.referrer).origin;
      if (PARENT_ORIGINS.indexOf(origin) !== -1) return origin;
    }
  } catch (e) {}
  return window.location.origin;
}

function fmtNum(n, digits) {
  if (n === null || n === undefined || Number.isNaN(n)) return "--";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: digits || 0,
    maximumFractionDigits: digits || 0,
  });
}

function hideLoading() {
  const el = document.getElementById("atlas-map-loading");
  if (!el) return;
  el.style.transition = "opacity 220ms ease-out";
  el.style.opacity = "0";
  setTimeout(function () { el.style.display = "none"; }, 240);
}

function showToast(msg, ttl) {
  let el = document.getElementById("atlas-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "atlas-toast";
    el.className = "atlas-toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("atlas-toast--visible");
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(function () {
    el.classList.remove("atlas-toast--visible");
  }, ttl || 2200);
}

// Register pmtiles:// protocol once
if (__pmtiles__ && __maplibregl__) {
  const pmtilesProtocol = new __pmtiles__.Protocol();
  __maplibregl__.addProtocol("pmtiles", pmtilesProtocol.tile);
}

// ── Map setup ──────────────────────────────────────────────────────────────
try {
  if (__maplibregl__ && __pmtiles__) {
mapInstance = new __maplibregl__.Map({
  container: "atlas-map",
  style: {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      esri: {
        type: "raster",
        tiles: [ESRI_IMAGERY],
        tileSize: 256,
        maxzoom: 19,
        attribution: "(c) Esri World Imagery",
      },
    },
    // Late-afternoon sun from the south-west so facades shade differently
    // and the blocks read as volumes. Lighting, not a drop shadow.
    light: { anchor: "map", position: [1.4, 210, 35], color: "#fff4e0", intensity: 0.45 },
    layers: [{
      id: "esri-imagery",
      type: "raster",
      source: "esri",
      // Muted like bkk-3d-atlas so the buildings, not the imagery, carry the eye.
      paint: { "raster-opacity": mapTheme().opacity, "raster-saturation": mapTheme().saturation, "raster-contrast": 0.05 },
    }],
  },
  center: HCMC_CENTER,
  zoom: 15.4,
  pitch: 60,
  bearing: -18,
  minZoom: 9,
  maxZoom: 18,
  renderWorldCopies: false,
  maxPitch: 70,
  hash: false,
  attributionControl: { customAttribution: "Heights: Google 2.5D / GHSL / OSM / estimates" },
});

  }
} catch (e) {
  console.warn("[atlas] map unavailable:", e.message);
  const el = document.getElementById("atlas-map-loading");
  if (el) el.textContent = "3D rendering is unavailable on this device. Use Data & sources below.";
}

if (mapInstance) {

requestAnimationFrame(function () { mapInstance.resize(); });

// Resolves once the style object exists. Registered here, at construction,
// because boot() awaits a fetch first: by then `style.load` may already have
// fired, and isStyleLoaded() stays false while satellite tiles are still
// loading -- so waiting for the event *after* the fetch could wait forever
// and the city layers would randomly never appear.


// Hide loading overlay once MapLibre has rendered at least one tile.
// A stuck overlay is worse than a brief flash, so we hide on:
//   1. `idle`  -- the normal "everything in viewport rendered" signal
//   2. `render` + loaded() -- mid-flight, just hide if we've drawn once
//   3. `error` -- a tile-source failure (e.g. PMTiles Range/cache glitch)
//      should NOT leave the user staring at the spinner; the map is still
//      usable via the basemap + waterways + metro layers
//   4. hard 4.5s timeout -- last-resort guarantee
let loadingHidden = false;
function hideLoadingIfReady(force) {
  if (loadingHidden) return;
  // isStyleLoaded() stays false while any one source is erroring, so the
  // error and timeout paths force it -- a broken layer must not blank the map.
  if (force !== true && !mapInstance.isStyleLoaded()) return;
  loadingHidden = true;
  hideLoading();
}
mapInstance.on("idle", function () {
  hideLoadingIfReady();
  if (!mapInstance.__atlasTileError) setToggleLabel("atlas-map-status", "Map ready. Buildings appear from zoom 12; choose a place in Quick jump.");
});
mapInstance.on("render", function () { if (mapInstance.loaded()) hideLoadingIfReady(); });
mapInstance.on("error", function (e) {
  // Log it so the developer can see why a tile failed, but never let it
  // block the loading overlay -- the user wants to interact with the rest
  // of the map even if one source is broken.
  mapInstance.__atlasTileError = true;
  if (e && e.error) console.warn("[atlas] tile error:", e.error.message || e.error);
  setToggleLabel("atlas-map-status", "Some map data could not load. Reload to retry; the text data below remains available.");
  hideLoadingIfReady(true);
});
setTimeout(function () { hideLoadingIfReady(true); }, 4500);

mapInstance.addControl(
  new __maplibregl__.NavigationControl({ visualizePitch: true }),
  "bottom-right",
);
mapInstance.addControl(new __maplibregl__.ScaleControl({ unit: "metric" }), "bottom-left");

}

const styleReady = new Promise(function (resolve) {
  if (!mapInstance || mapInstance.style && mapInstance.style._loaded) resolve();
  else mapInstance.once("style.load", resolve);
});

// ── Building height + paint ────────────────────────────────────────────────
// Real metres, no multiplier. Same clamp as bkk-3d-atlas: heights outside
// 1-500 m are corrupt tags and fall back to 10 m (HCMC tube-house median).
// Density is what makes the city read in 3D, not inflated heights -- the
// v2 PMTiles carries Overture's OSM + Microsoft + Google footprints, with
// unmeasured buildings at their GHSL satellite cell height.
// Properties from scripts/bake-buildings.py: h, b, hs, src, cls, name.
const HEIGHT_RAW = ["to-number", ["coalesce", ["get", "h"], ["get", "render_height"], ["get", "height"]], 0];
// Real metres. Heights outside 1-500 m are corrupt tags -> 10 m.
// Never multiply this: an 8 m tube house drawn 32 m tall is the
// "vertical spaghetti" the 2026-09/10 passes kept shipping.
const HEIGHT_GET = ["case", [">=", HEIGHT_RAW, 1], ["case", ["<=", HEIGHT_RAW, 500], HEIGHT_RAW, 10], 10];
// Base must stay strictly below height -- base >= height makes MapLibre
// emit degenerate roof triangles that read as sawteeth.
const BASE_RAW = ["to-number", ["coalesce", ["get", "b"], ["get", "render_min_height"], ["get", "min_height"]], 0];
const BASE_GET = ["case", [">=", BASE_RAW, HEIGHT_GET], 0, ["max", 0, BASE_RAW]];

// One neutral body; height only lifts the value a little so towers catch
// light. The single amber belongs to landmarks and selection.
const BUILDING_COLOR = [
  "interpolate", ["linear"], HEIGHT_GET,
  6,   "#b9b2a4",
  20,  "#d6cfbf",
  60,  "#e8e2d4",
  150, "#f4f0e6",
];

// Opacity hits 1.0 by street zoom -- translucent fill-extrusion z-fights
// into glittery roof shards on Chrome/macOS.
const BUILDING_OPACITY = ["interpolate", ["linear"], ["zoom"], 11, 0.6, 13, 0.88, 14.5, 1];

const HEIGHT_SOURCE_LABEL = {
  measured: "tagged (OSM / survey; date unverified)",
  floors: "estimate: floor count × 3.3 m; date unverified",
  google: "satellite, this building (Google Open Buildings 2.5D, 2023)",
  ghsl: "satellite, 100 m area average (GHSL, 2018)",
  satellite: "satellite, 100 m area average (GHSL, 2018)",
  estimated: "type default; no measurement; date unverified",
};

const FOOTPRINT_SOURCE_LABEL = {
  osm: "OpenStreetMap",
  ms: "Microsoft ML (satellite)",
  google: "Google Open Buildings (satellite)",
};

function addBuildings() {
  mapInstance.addSource("hcmc-buildings-src", {
    type: "vector",
    url: "pmtiles://" + PMTILES_BUILDINGS,
    maxzoom: 15,
    attribution: "(c) OpenStreetMap, Microsoft, Google via Overture Maps",
  });
  mapInstance.addLayer({
    id: "hcmc-buildings",
    type: "fill-extrusion",
    source: "hcmc-buildings-src",
    "source-layer": "buildings",
    minzoom: 12,
    paint: {
      "fill-extrusion-color": [
        "case",
        ["boolean", ["feature-state", "selected"], false], "#f59e0b",
        BUILDING_COLOR,
      ],
      "fill-extrusion-height": HEIGHT_GET,
      "fill-extrusion-base": BASE_GET,
      "fill-extrusion-opacity": BUILDING_OPACITY,
      "fill-extrusion-vertical-gradient": true,
    },
  });
  // Building outlines on hover/select (feature-state)
  mapInstance.addLayer({
    id: "hcmc-buildings-outline",
    type: "line",
    source: "hcmc-buildings-src",
    "source-layer": "buildings",
    minzoom: 14.5,
    paint: {
      "line-color": "#f59e0b",
      "line-width": [
        "case",
        ["boolean", ["feature-state", "selected"], false], 2.5,
        ["boolean", ["feature-state", "hover"], false], 1.2,
        0,
      ],
      "line-opacity": [
        "case",
        ["boolean", ["feature-state", "selected"], false], 0.95,
        ["boolean", ["feature-state", "hover"], false], 0.55,
        0,
      ],
    },
  });
}

function addWaterways() {
  mapInstance.addSource("hcmc-waterways-src", {
    type: "vector",
    url: "pmtiles://" + PMTILES_WATERWAYS,
    attribution: "(c) OpenStreetMap contributors",
  });
  mapInstance.addLayer({
    id: "waterways-line",
    type: "line",
    source: "hcmc-waterways-src",
    "source-layer": "waterways",
    minzoom: 10,
    paint: {
      "line-color": "#1d4ed8",
      "line-width": [
        "interpolate", ["linear"], ["zoom"],
        10, 0.4,
        13, 1.2,
        16, 2.4,
      ],
      "line-opacity": 0.75,
    },
  });
}

function addMetro() {
  // Metro Line 1 (Ben Thanh - Suoi Tien), 14 stations.
  // Real coordinates from the HCMC Urban Railway project master plan.
  const stations = [
    { id: "s1-01", name: "Ben Thanh",        lng: 106.7004, lat: 10.7720 },
    { id: "s1-02", name: "Nha Hat",         lng: 106.6995, lat: 10.7769 },
    { id: "s1-03", name: "Ba Son",          lng: 106.7050, lat: 10.7826 },
    { id: "s1-04", name: "Van Thanh",       lng: 106.7123, lat: 10.7874 },
    { id: "s1-05", name: "Tan Cang",        lng: 106.7208, lat: 10.7927 },
    { id: "s1-06", name: "Thao Dien",       lng: 106.7306, lat: 10.8014 },
    { id: "s1-07", name: "An Ph",          lng: 106.7428, lat: 10.8089 },
    { id: "s1-08", name: "Rach Chiec",      lng: 106.7565, lat: 10.8155 },
    { id: "s1-09", name: "Phuoc Long",      lng: 106.7698, lat: 10.8237 },
    { id: "s1-10", name: "Binh Thai",       lng: 106.7841, lat: 10.8328 },
    { id: "s1-11", name: "Thu Duc",         lng: 106.8003, lat: 10.8424 },
    { id: "s1-12", name: "Khu Cong Nghe",   lng: 106.8163, lat: 10.8517 },
    { id: "s1-13", name: "DHQG TP.HCM",     lng: 106.8319, lat: 10.8604 },
    { id: "s1-14", name: "Suoi Tien",       lng: 106.8468, lat: 10.8721 },
  ];
  const lineCoords = stations.map(function (s) { return [s.lng, s.lat]; });

  mapInstance.addSource("metro-line-src", {
    type: "geojson",
    data: {
      type: "Feature",
      properties: { line: "M1", name: "Ben Thanh - Suoi Tien" },
      geometry: { type: "LineString", coordinates: lineCoords },
    },
  });
  mapInstance.addLayer({
    id: "metro-line",
    type: "line",
    source: "metro-line-src",
    minzoom: 10,
    paint: {
      "line-color": "#dc2626",
      "line-width": [
        "interpolate", ["linear"], ["zoom"],
        10, 1,
        13, 3,
        16, 5,
      ],
      "line-opacity": 0.9,
    },
  });

  mapInstance.addSource("metro-stations-src", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: stations.map(function (s) {
        return {
          type: "Feature",
          properties: { id: s.id, name: s.name },
          geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        };
      }),
    },
  });
  mapInstance.addLayer({
    id: "metro-stations",
    type: "circle",
    source: "metro-stations-src",
    minzoom: 12,
    paint: {
      "circle-radius": [
        "interpolate", ["linear"], ["zoom"],
        11, 2,
        14, 5,
        16, 7,
      ],
      "circle-color": "#ffffff",
      "circle-stroke-color": "#dc2626",
      "circle-stroke-width": 2,
      "circle-stroke-opacity": 1,
    },
  });
  mapInstance.addLayer({
    id: "metro-stations-label",
    type: "symbol",
    source: "metro-stations-src",
    minzoom: 13,
    layout: {
      "text-field": ["get", "name"],
      "text-size": [
        "interpolate", ["linear"], ["zoom"],
        13, 9,
        16, 12,
      ],
      "text-offset": [0, 1.2],
      "text-anchor": "top",
      "text-allow-overlap": false,
      "text-optional": true,
    },
    paint: {
      "text-color": "#fef2f2",
      "text-halo-color": "#0a0a0a",
      "text-halo-width": 1.2,
    },
  });
}

function addBusStops() {
  // Positions come from the dashboard feed. That feed is a simulation
  // until a public GTFS-Realtime source exists — the label says so.
  mapInstance.addSource("bus-stops-src", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  mapInstance.addLayer({
    id: "bus-stops",
    type: "circle",
    source: "bus-stops-src",
    minzoom: 12,
    paint: {
      "circle-radius": 4,
      "circle-color": "#facc15",
      "circle-stroke-color": "#0a0a0a",
      "circle-stroke-width": 0.6,
      "circle-stroke-opacity": 0.7,
    },
  });
}

function addCivicPOIs() {
  // Curated hero landmarks load as 3D extrusions from hcmc-landmarks.geojson.
  // The legacy hard-coded dot list below is retained as a fallback pin layer for
  // the few OSM POIs that aren't worth extruding (Tan Son Nhat, Ba Son).
  const POIS = [
    { lng: 106.7050, lat: 10.7826, name: "Ba Son" },
    { lng: 106.6519, lat: 10.808, name: "Tan Son Nhat" },
  ];
  mapInstance.addSource("civic-pois-src", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: POIS.map(function (p) {
        return {
          type: "Feature",
          properties: { name: p.name },
          geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        };
      }),
    },
  });
  mapInstance.addLayer({
    id: "civic-pois",
    type: "circle",
    source: "civic-pois-src",
    minzoom: 12,
    paint: {
      "circle-radius": [
        "interpolate", ["linear"], ["zoom"],
        12, 2,
        16, 6,
      ],
      "circle-color": "#f5f5f4",
      "circle-stroke-color": "#a78bfa",
      "circle-stroke-width": 1.4,
    },
  });
  mapInstance.addLayer({
    id: "civic-pois-label",
    type: "symbol",
    source: "civic-pois-src",
    minzoom: 14,
    layout: {
      "text-field": ["get", "name"],
      "text-size": 11,
      "text-offset": [0, 1.4],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "text-color": "#fef2f2",
      "text-halo-color": "#0a0a0a",
      "text-halo-width": 1.2,
    },
  });
}

// ── Flood zones ────────────────────────────────────────────────────────────
// Eight documented recurring-flood polygons (HCMC Steering Center for
// Flood Control + triều cường reporting). Polygons go in muted red
// with a hatched outline so they read as a warning, not a building.
async function addFloodZones() {
  let doc;
  try {
    const r = await fetch(ATLAS_BASE + "/hcmc-flood-zones.geojson", { cache: "no-store" });
    if (!r.ok) throw new Error("flood zones " + r.status);
    doc = await r.json();
  } catch (e) {
    console.warn("[atlas] flood zones unavailable:", e.message);
    return;
  }
  const features = (doc.features || []).filter(function (f) {
    const g = f.geometry;
    return g && (g.type === "Polygon" || g.type === "MultiPolygon");
  });
  if (!features.length) return;
  mapInstance.addSource("hcmc-flood-zones-src", {
    type: "geojson",
    data: { type: "FeatureCollection", features: features },
    attribution: "Indicative flood areas: atlas curation, not surveyed extents",
  });
  // Fill — muted red, semi-transparent so satellite shows through.
  mapInstance.addLayer({
    id: "flood-zones",
    type: "fill",
    source: "hcmc-flood-zones-src",
    paint: {
      "fill-color": [
        "match",
        ["get", "riskLevel"],
        "high", "#dc2626",
        "medium", "#f59e0b",
        "#9ca3af",
      ],
      "fill-opacity": 0.22,
    },
  });
  // Outline — sharp warning border.
  mapInstance.addLayer({
    id: "flood-zones-outline",
    type: "line",
    source: "hcmc-flood-zones-src",
    paint: {
      "line-color": [
        "match",
        ["get", "riskLevel"],
        "high", "#ef4444",
        "medium", "#f59e0b",
        "#9ca3af",
      ],
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.8, 14, 2.5],
      "line-dasharray": [3, 2],
    },
  });
  // Label — zone name on hover only (to keep city-overview uncluttered).
  mapInstance.addLayer({
    id: "flood-zones-label",
    type: "symbol",
    source: "hcmc-flood-zones-src",
    minzoom: 13,
    layout: {
      "text-field": ["get", "name_en"],
      "text-size": 10,
      "text-offset": [0, 0],
      "text-anchor": "center",
      "text-optional": true,
    },
    paint: {
      "text-color": "#fecaca",
      "text-halo-color": "#0a0a0a",
      "text-halo-width": 1,
    },
  });
  setLayerVisible("flood-zones", layerVisibility["flood-zones"] !== false);
}

// ── Air quality / aerosol (Open-Meteo) ────────────────────────────────────
// Live aerosol points proxied from the dashboard's /api/air-quality
// endpoint. Color follows AQI category, size scales with PM2.5.
async function addAirQuality() {
  const features = [];
  mapInstance.addSource("hcmc-aqi-src", {
    type: "geojson",
    data: { type: "FeatureCollection", features: features },
    attribution: "Air-quality model: CAMS via Open-Meteo",
  });
  mapInstance.addLayer({
    id: "aqi-points",
    type: "circle",
    source: "hcmc-aqi-src",
    minzoom: 10,
    paint: {
      "circle-radius": [
        "interpolate", ["linear"], ["zoom"],
        10, 6,
        16, 18,
      ],
      "circle-color": [
        "match",
        ["get", "category"],
        "Good", "#22c55e",
        "Moderate", "#facc15",
        "Unhealthy for Sensitive", "#f97316",
        "Unhealthy for Sensitive Groups", "#f97316",
        "Unhealthy", "#ef4444",
        "Very Unhealthy", "#a21caf",
        "Hazardous", "#7f1d1d",
        "#9ca3af",
      ],
      "circle-opacity": 0.7,
      "circle-stroke-color": "#0a0a0a",
      "circle-stroke-width": 0.6,
    },
  });
  mapInstance.addLayer({
    id: "aqi-labels",
    type: "symbol",
    source: "hcmc-aqi-src",
    minzoom: 12,
    layout: {
      "text-field": ["concat", ["to-string", ["round", ["get", "aqi"]]], " AQI · model"],
      "text-size": 10,
      "text-offset": [0, 1.6],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "text-color": "#fde68a",
      "text-halo-color": "#0a0a0a",
      "text-halo-width": 1,
    },
  });
}

// ── Hero landmarks — actual 3D extrusions for Bitexco, Landmark 81, Notre Dame,
// City Hall, etc. (hcmc-landmarks.geojson). The geometry is the real building
// footprint; the height field is the published metres. The fill-extrusion
// uses real metre units for the curated part heights. Part geometry and
// heights are a reference model, not an as-built survey.
async function addHeroLandmarks() {
  let doc;
  try {
    const r = await fetch(ATLAS_BASE + "/hcmc-landmarks.geojson", { cache: "no-store" });
    if (!r.ok) throw new Error("hero landmarks fetch " + r.status);
    doc = await r.json();
  } catch (e) {
    console.warn("[atlas] hero landmarks unavailable:", e.message);
    return;
  }
  const features = (doc.features || []).filter(function (f) {
    const g = f.geometry;
    return g && (g.type === "Polygon" || g.type === "MultiPolygon");
  });
  if (!features.length) {
    console.warn("[atlas] hero landmarks file has no polygon features");
    return;
  }

  mapInstance.addSource("hcmc-landmarks-src", {
    type: "geojson",
    data: { type: "FeatureCollection", features: features },
    attribution: "Landmarks (c) OpenStreetMap",
  });

  // Landmarks carry the one accent. Real footprints from OSM, published
  // heights with a cited source (scripts/curate-landmarks.py); parts stack
  // via base_height so towers get their podium + shaft silhouette.
  mapInstance.addLayer({
    id: "hcmc-landmarks-3d",
    type: "fill-extrusion",
    source: "hcmc-landmarks-src",
    minzoom: 11,
    paint: {
      "fill-extrusion-color": ["match", ["get", "category"], "civic", "#e0a33a", "#f59e0b"],
      "fill-extrusion-height": ["coalesce", ["get", "height"], 12],
      "fill-extrusion-base": ["coalesce", ["get", "base_height"], 0],
      "fill-extrusion-opacity": 1,
      "fill-extrusion-vertical-gradient": true,
    },
  });

  // Outline so the edges of the towers read crisply against the satellite.
  mapInstance.addLayer({
    id: "hcmc-landmarks-outline",
    type: "line",
    source: "hcmc-landmarks-src",
    paint: {
      "line-color": "#f59e0b",
      "line-width": 1,
      "line-opacity": 0.5,
    },
  });

  // Names appear when zoomed in past 13.5 — keep the city-scale view clean.
  mapInstance.addLayer({
    id: "hcmc-landmarks-label",
    type: "symbol",
    source: "hcmc-landmarks-src",
    minzoom: 13.5,
    filter: ["!=", ["get", "part"], true], // one label per landmark, not per part
    layout: {
      "text-field": ["get", "name"],
      "text-size": [
        "interpolate", ["linear"], ["zoom"],
        13.5, 9,
        16, 13,
      ],
      "text-offset": [0, 1.0],
      "text-anchor": "top",
      "text-optional": true,
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": "#fef9c3",
      "text-halo-color": "#0a0a0a",
      "text-halo-width": 1.4,
    },
  });

  applyMapTheme();
  setLayerVisible("hcmc-landmarks-3d", layerVisibility["hcmc-landmarks-3d"] !== false);
  // Inject the hero list into the inspect card hero enum so picking a building
  // near Bitexco surfaces the correct canonical record.
  window.__hcmcHeroLandmarks = features.map(function (f) {
    return Object.assign({}, f.properties, { geometry: f.geometry });
  });
}

function addLiveSensors() {
  mapInstance.addSource("live-sensors-src", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  mapInstance.addLayer({
    id: "live-sensors",
    type: "circle",
    source: "live-sensors-src",
    minzoom: 11,
    paint: {
      "circle-radius": [
        "interpolate", ["linear"], ["zoom"],
        11, 3,
        16, 8,
      ],
      "circle-color": [
        "match", ["get", "status"],
        "alert", "#ef4444",
        "warning", "#f59e0b",
        "normal", "#22c55e",
        "#9ca3af",
      ],
      "circle-stroke-color": "#0a0a0a",
      "circle-stroke-width": 0.5,
      "circle-opacity": 0.85,
    },
  });


}

function applyAllLayers() {
  addBuildings();
  addHeroLandmarks();
  addWaterways();
  addMetro();
  addBusStops();
  addCivicPOIs();
  addFloodZones();
  addAirQuality();
  addLiveSensors();
  applyMapTheme();
  // Ground lines go under the extrusions so towers occlude them, instead of
  // the river and the metro line painting across building faces.
  ["waterways-line", "metro-line"].forEach(function (id) {
    if (mapInstance.getLayer(id)) mapInstance.moveLayer(id, "hcmc-buildings");
  });
}

// ── Text evidence (available even when WebGL or map tiles fail) ───────────
function observationStale(stamp, maxAge) {
  const time = stamp ? Date.parse(stamp) : NaN;
  return !Number.isFinite(time) || time > Date.now() + 5 * 60000 || Date.now() - time > maxAge;
}
function observationLabel(stamp) {
  const time = stamp ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(time)) return "Observation time unknown";
  if (time > Date.now() + 5 * 60000) return "Observation time is in the future; unverified";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  const age = minutes < 60 ? minutes + " min" : minutes < 1440 ? Math.floor(minutes / 60) + " h" : Math.floor(minutes / 1440) + " d";
  return age + " ago · " + new Date(time).toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "medium", timeStyle: "short" }) + " ICT";
}
function evidenceCell(source, tier, stamp) {
  return escapeHtml(source || "Source unknown") + " · " + escapeHtml(tier || "unverified") + "<small>" + escapeHtml(observationLabel(stamp)) + "</small>";
}
function renderSensorTable(rows, provenance, unavailable) {
  const el = document.getElementById("atlas-sensor-rows");
  if (!el) return;
  el.innerHTML = rows.length ? rows.map(function (r) {
    const stale = unavailable || r.stale || observationStale(r.observedAt, 6 * 3600000);
    const value = Number.isFinite(r.value) ? fmtNum(r.value, 1) + " " + (r.unit || "unit unknown") : "Reading unavailable";
    return "<tr><th scope=\"row\">" + escapeHtml(r.label || r.id) + "</th><td>" + escapeHtml(value) + "<small>" + escapeHtml(stale ? "Stale / unverified" : r.status || "Status unknown") + "</small></td><td>" + evidenceCell(provenance?.source, unavailable ? "last retrieved / unavailable" : provenance?.tier, r.observedAt) + "</td></tr>";
  }).join("") : '<tr><td colspan="3">No sensor readings available.</td></tr>';
  setToggleLabel("atlas-sensor-status", unavailable ? "Sensor feed unavailable. Any retained readings are last retrieved values, not current conditions." : rows.some(function (r) { return r.stale || observationStale(r.observedAt, 6 * 3600000); }) ? "Stale observations are retained for reference. They do not establish current flood conditions." : "Sensor records retrieved. Check each observation time and source tier.");
}
async function refreshAirQuality() {
  const data = await fetchLive("/api/atlas/air-quality", 300);
  const available = Array.isArray(data);
  if (available) lastAirQuality = data.filter(function (p) {
    return p && Number.isFinite(p.lng) && Number.isFinite(p.lat) && Number.isFinite(p.aqi) && p.aqi >= 0;
  });
  const rows = lastAirQuality;
  const features = rows.map(function (p) {
    const stale = !available || observationStale(p.observedAt, 3 * 3600000);
    return { type: "Feature", properties: {
      label: p.label, aqi: p.aqi, pm25: p.pm25, category: stale ? "stale" : p.category,
      source: p.provenance?.source || p.source, tier: p.provenance?.tier || "unverified", observedAt: p.observedAt,
    }, geometry: { type: "Point", coordinates: [p.lng, p.lat] } };
  });
  const src = mapInstance && mapInstance.getSource("hcmc-aqi-src");
  if (src) src.setData({ type: "FeatureCollection", features: features });
  const el = document.getElementById("atlas-aqi-rows");
  if (el) el.innerHTML = rows.length ? rows.map(function (p) {
    const modeled = /open-meteo|cams/i.test(p.source || p.provenance?.source || "");
    const tier = !available ? "last retrieved / unavailable" : observationStale(p.observedAt, 3 * 3600000) ? "stale" : modeled ? "modeled" : p.provenance?.tier || "unverified";
    const pm25 = Number.isFinite(p.pm25) && p.pm25 >= 0 ? " · PM2.5 " + fmtNum(p.pm25, 1) + " µg/m³" : " · PM2.5 unavailable";
    return '<tr><th scope="row">' + escapeHtml(p.label || "Unnamed location") + '</th><td>' + escapeHtml(Math.round(p.aqi) + " AQI" + pm25) + '<small>' + escapeHtml(p.category || "Category unknown") + '</small></td><td>' + evidenceCell(p.provenance?.source || p.source, tier, p.observedAt) + '</td></tr>';
  }).join("") : '<tr><td colspan="3">No valid air-quality values available.</td></tr>';
  setToggleLabel("atlas-aqi-label", available && rows.length ? "Air quality · model" : "Air quality · unavailable");
  setToggleLabel("atlas-aqi-status", available && rows.length ? "Model estimates retrieved. Valid time and source appear with each value." : "Air-quality feed unavailable or invalid. Retained values, if any, are marked last retrieved.");
}
async function loadReferenceText() {
  const [landmarks, flood] = await Promise.all([
    fetchLive("/hcmc-landmarks.geojson", 3600), fetchLive("/hcmc-flood-zones.geojson", 3600),
  ]);
  const el = document.getElementById("atlas-reference-list");
  if (!el) return;
  const names = new Map();
  if (Array.isArray(landmarks?.features)) landmarks.features.forEach(function (f) {
    const p = f?.properties;
    if (!p || !Number.isFinite(p.height)) return;
    const prior = names.get(p.name);
    if (!prior || p.height > prior.height) names.set(p.name, p);
  });
  const entries = Array.from(names.values()).map(function (p) {
    return '<li>' + escapeHtml(p.name) + ': highest modeled part ' + escapeHtml(p.height) + ' m. Reference: ' + escapeHtml(p.source || "unknown") + '. Tier: curated model; reference date unverified.</li>';
  });
  if (Array.isArray(flood?.features)) flood.features.forEach(function (f) {
    if (f?.properties) entries.push('<li>Flood reference area: ' + escapeHtml(f.properties.name_en || f.properties.name) + '. Approximate atlas sketch; date unverified.</li>');
  });
  el.innerHTML = entries.length ? '<ul class="atlas-reference-list">' + entries.join("") + '</ul>' : '<p>Reference files unavailable. Reload to retry.</p>';
}

// ── Live data fetchers (proxied via the dashboard Worker) ─────────────────
async function fetchLive(endpoint, ttl) {
  const cached = liveCache.get(endpoint);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (liveRequests.has(endpoint)) return liveRequests.get(endpoint);
  const pending = (async function () {
    try {
      const r = await fetch(ATLAS_BASE + endpoint, {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      const data = await r.json();
      liveCache.set(endpoint, { value: data, expires: Date.now() + (ttl || 60) * 1000 });
      return data;
    } catch (e) { return null; }
  })();
  liveRequests.set(endpoint, pending);
  try { return await pending; } finally { liveRequests.delete(endpoint); }
}

function setToggleLabel(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

async function refreshLiveOverlay() {
  const received = await fetchLive("/api/traffic", 30);
  const data = received && Array.isArray(received.sensors) && Array.isArray(received.buses) ? received : null;
  if (data) liveSensors = data;
  const sensorRows = Array.isArray(liveSensors.sensors) ? liveSensors.sensors : [];
  const evidence = liveSensors.provenance?.sensors;
  renderSensorTable(sensorRows, evidence, !data);
  const sensorSrc = mapInstance && mapInstance.getSource("live-sensors-src");
  if (sensorSrc) {
    sensorSrc.setData({
      type: "FeatureCollection",
      features: sensorRows.map(function (r) {
        if (!Number.isFinite(r.lng) || !Number.isFinite(r.lat)) return null;
        return {
          type: "Feature",
          properties: {
            id: r.id,
            label: r.label || r.id,
            unit: r.unit,
            status: !data || r.stale || observationStale(r.observedAt, 6 * 3600000) ? "stale" : r.status || "unknown",
            value: r.value,
            observedAt: r.observedAt,
            tier: evidence && evidence.tier,
          },
          geometry: { type: "Point", coordinates: [r.lng, r.lat] },
        };
      }).filter(Boolean),
    });
  }
  const stale = !data || sensorRows.some(function (r) { return r.stale || observationStale(r.observedAt, 6 * 3600000); });
  setToggleLabel("atlas-sensor-label", !data ? "VNTT sensors · unavailable" : stale ? "VNTT sensors · stale" : "VNTT sensors · " + (evidence?.tier || "unverified"));

  const busSrc = mapInstance && mapInstance.getSource("bus-stops-src");
  if (busSrc) {
    busSrc.setData({
      type: "FeatureCollection",
      features: (data ? data.buses : []).map(function (p) {
        if (!Number.isFinite(p.lng) || !Number.isFinite(p.lat)) return null;
        return {
          type: "Feature",
          properties: {
            id: p.id,
            name: p.route || p.id,
            tier: data.provenance && data.provenance.buses && data.provenance.buses.tier,
          },
          geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        };
      }).filter(Boolean),
    });
  }
  const busTier = data?.provenance?.buses?.tier || "unverified";
  setToggleLabel("atlas-bus-label", data ? "Buses · " + busTier : "Buses · unavailable");
  setToggleLabel("atlas-bus-status", data ? "Bus positions: " + busTier + ". Source: " + (data.provenance?.buses?.source || "unknown") + ". " + observationLabel(data.provenance?.buses?.observedAt || data.provenance?.buses?.fetchedAt) : "Bus feed unavailable; map positions are hidden.");
}

// ── Areas + flyTo + flyover ────────────────────────────────────────────────
function renderAreaGrid() {
  const grid = document.getElementById("atlas-area-grid");
  if (!grid || !areasDoc) return;
  grid.innerHTML = "";
  for (const area of areasDoc.areas) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "atlas-area-tile";
    tile.dataset.areaId = area.id;
    tile.setAttribute("aria-pressed", "false");
    tile.setAttribute("aria-label", "Fly to " + area.name);
    tile.innerHTML =
      '<span class="atlas-area-tile-cat">' + escapeHtml(area.category || "city") + "</span>" +
      '<span class="atlas-area-tile-name">' + escapeHtml(area.name) + "</span>" +
      '<span class="atlas-area-tile-namevi">' + escapeHtml(area.vietnamese || "") + "</span>";
    tile.addEventListener("click", function () { flyToArea(area.id, { updateHash: true }); });
    grid.appendChild(tile);
  }
}

function flyToArea(id, opts) {
  opts = opts || {};
  if (!areasDoc) return;
  if (!mapInstance) { showToast("3D map unavailable; reference data is below."); return; }
  const area = areasDoc.areas.find(function (a) { return a.id === id; });
  if (!area) return;
  currentAreaId = id;
  if (opts.instant || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    mapInstance.jumpTo({
      center: area.center,
      zoom: area.zoom || 14,
      pitch: area.pitch || 50,
      bearing: area.bearing || 0,
    });
  } else {
    mapInstance.flyTo({
      center: area.center,
      zoom: area.zoom || 14,
      pitch: area.pitch || 50,
      bearing: area.bearing || 0,
      duration: 1800,
      essential: false,
    });
  }
  if (opts.updateHash) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("area", id);
      history.replaceState(null, "", url.toString());
    } catch (e) {}
  }
  $$(".atlas-area-tile").forEach(function (b) {
    b.classList.toggle("atlas-area-tile--active", b.dataset.areaId === id);
    b.setAttribute("aria-pressed", String(b.dataset.areaId === id));
  });
}

function startFlyover() {
  if (!mapInstance || !areasDoc || areasDoc.areas.length === 0) return;
  stopFlyover();
  let idx = 0;
  flyoverTimer = setInterval(function () {
    const area = areasDoc.areas[idx % areasDoc.areas.length];
    flyToArea(area.id, { updateHash: true });
    idx++;
  }, 4500);
  showToast("Flyover started -- " + areasDoc.areas.length + " stops");
  const btn = document.getElementById("atlas-flyover-btn");
  if (btn) { btn.textContent = "Stop flyover"; btn.setAttribute("aria-pressed", "true"); }
}
function stopFlyover() {
  if (flyoverTimer) clearInterval(flyoverTimer);
  flyoverTimer = null;
  const btn = document.getElementById("atlas-flyover-btn");
  if (btn) { btn.textContent = "Start flyover"; btn.setAttribute("aria-pressed", "false"); }
}

// ── Live sun ────────────────────────────────────────────────────────────────
// The light on the buildings is the real sun over Saigon right now (NOAA
// low-precision solar position, good to ~0.5 deg). After dark the light
// goes overhead, cool and dim -- the city at night, not a fixed noon.
function sunOverHcmc(date) {
  const rad = Math.PI / 180;
  const lat = 10.776 * rad, lon = 106.700;
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lon) * rad) - ra;
  const alt = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
  return { altitude: alt / rad, azimuth: ((az / rad) + 360) % 360 };
}

function applySunLight() {
  const sun = sunOverHcmc(new Date());
  const day = sun.altitude > 0;
  mapInstance.setLight({
    anchor: "map",
    position: day ? [1.4, sun.azimuth, Math.max(10, 90 - sun.altitude)] : [1.2, 0, 20],
    color: day ? (sun.altitude < 12 ? "#ffd9a8" : "#fff4e0") : "#9fb4d8",
    intensity: day ? 0.5 : 0.28,
  });
}

// ── Idle orbit ─────────────────────────────────────────────────────────────
// After 20 s untouched the camera turns slowly round the view, so a shared
// link opened on a phone shows depth without a gesture. Any touch stops it.
let orbitEnabled = false;
let orbitIdleTimer = null;
let orbiting = false;
const ORBIT_DEG_PER_SEC = 2.5;
function orbitStep() {
  if (!orbiting) return;
  mapInstance.easeTo({ bearing: mapInstance.getBearing() + ORBIT_DEG_PER_SEC * 4, duration: 4000, easing: function (t) { return t; } });
}
function armIdleOrbit() {
  clearTimeout(orbitIdleTimer);
  orbiting = false;
  if (!orbitEnabled || window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  orbitIdleTimer = setTimeout(function () {
    if (flyoverTimer || mapInstance.getZoom() < 12) return armIdleOrbit();
    orbiting = true;
    orbitStep();
  }, 20000);
}

// ── Inspect (click any building) ──────────────────────────────────────────
function closeInspect() {
  const panel = document.getElementById("atlas-inspect");
  if (panel) panel.hidden = true;
  if (inspectFeature && mapInstance) {
    mapInstance.setFeatureState({ source: "hcmc-buildings-src", sourceLayer: "buildings", id: inspectFeature.id }, { selected: false });
    inspectFeature = null;
  }
}

function setupInspect() {
  document.getElementById("atlas-inspect-close")?.addEventListener("click", closeInspect);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeInspect(); stopFlyover(); } });
  let hoveredFeature = null;
  mapInstance.on("mousemove", "hcmc-buildings", function (e) {
    if (!e.features || !e.features[0]) return;
    if (hoveredFeature && hoveredFeature.id !== e.features[0].id) {
      mapInstance.setFeatureState({ source: "hcmc-buildings-src", sourceLayer: "buildings", id: hoveredFeature.id }, { hover: false });
    }
    hoveredFeature = e.features[0];
    mapInstance.setFeatureState({ source: "hcmc-buildings-src", sourceLayer: "buildings", id: hoveredFeature.id }, { hover: true });
    mapInstance.getCanvas().style.cursor = "pointer";
  });
  mapInstance.on("mouseleave", "hcmc-buildings", function () {
    if (hoveredFeature) {
      mapInstance.setFeatureState({ source: "hcmc-buildings-src", sourceLayer: "buildings", id: hoveredFeature.id }, { hover: false });
    }
    hoveredFeature = null;
    mapInstance.getCanvas().style.cursor = "";
  });

  mapInstance.on("click", "hcmc-buildings", function (e) {
    const f = e.features && e.features[0];
    if (!f) return;
    const props = f.properties || {};
    const h = Number(props.h || props.render_height || props.height || 0);
    const hs = props.hs || null;
    const bldg = props.cls || props.building || "building";
    const card = document.getElementById("atlas-inspect-card");
    const hint = document.getElementById("atlas-inspect-hint");
    const coords = document.getElementById("atlas-inspect-coords");
    const propsEl = document.getElementById("atlas-inspect-props");
    if (!card || !propsEl) return;

    const center = e.lngLat;
    coords.textContent = "lat " + center.lat.toFixed(4) + " -- lng " + center.lng.toFixed(4);
    propsEl.innerHTML =
      '<div class="atlas-inspect-row"><span>Type</span><strong>' + escapeHtml(bldg) + "</strong></div>" +
      '<div class="atlas-inspect-row"><span>Height</span><strong>' + escapeHtml(h ? h.toFixed(1) + " m" : "unknown") + "</strong></div>" +
      ('<div class="atlas-inspect-row"><span>Height from</span><strong>' + escapeHtml(HEIGHT_SOURCE_LABEL[hs] || hs || "unknown") + "</strong></div>") +
      (props.name ? '<div class="atlas-inspect-row"><span>Name</span><strong>' + escapeHtml(props.name) + "</strong></div>" : "") +
      '<div class="atlas-inspect-row"><span>Footprint</span><strong>' + escapeHtml(FOOTPRINT_SOURCE_LABEL[props.src] || props.src || "unknown") + "</strong></div>";

    if (hint) hint.style.display = "none";
    card.hidden = false;
    document.getElementById("atlas-inspect").hidden = false;

    if (inspectFeature) {
      mapInstance.setFeatureState({ source: "hcmc-buildings-src", sourceLayer: "buildings", id: inspectFeature.id }, { selected: false });
    }
    inspectFeature = f;
    mapInstance.setFeatureState({ source: "hcmc-buildings-src", sourceLayer: "buildings", id: f.id }, { selected: true });
  });

  mapInstance.on("click", "hcmc-landmarks-3d", function (e) {
    const props = e.features?.[0]?.properties;
    if (!props) return;
    closeInspect();
    document.getElementById("atlas-inspect-coords").textContent = "lat " + e.lngLat.lat.toFixed(4) + " · lng " + e.lngLat.lng.toFixed(4);
    document.getElementById("atlas-inspect-props").innerHTML =
      '<div class="atlas-inspect-row"><span>Name</span><strong>' + escapeHtml(props.name) + '</strong></div>' +
      '<div class="atlas-inspect-row"><span>Part height</span><strong>' + escapeHtml(props.height) + ' m</strong></div>' +
      '<div class="atlas-inspect-row"><span>Tier</span><strong>Curated reference model</strong></div>' +
      '<div class="atlas-inspect-row"><span>Reference</span><strong>' + escapeHtml(props.source || "unknown") + '</strong></div>' +
      '<div class="atlas-inspect-row"><span>Footprint</span><strong>OpenStreetMap ' + escapeHtml(props.osm) + '</strong></div>';
    document.getElementById("atlas-inspect-hint").style.display = "none";
    document.getElementById("atlas-inspect-card").hidden = false;
    document.getElementById("atlas-inspect").hidden = false;
  });
  mapInstance.on("click", function (e) {
    const layers = ["hcmc-buildings", "hcmc-landmarks-3d"].filter(function (id) { return mapInstance.getLayer(id); });
    const hits = layers.length ? mapInstance.queryRenderedFeatures(e.point, { layers: layers }) : [];
    if (!hits.length) closeInspect();
  });
}

// ── Layer toggles + basemap ────────────────────────────────────────────────
const LAYER_GROUPS = {
  "hcmc-buildings": ["hcmc-buildings", "hcmc-buildings-outline"],
  "metro-stations": ["metro-stations", "metro-stations-label"],
  "hcmc-landmarks-3d": ["hcmc-landmarks-3d", "hcmc-landmarks-outline", "hcmc-landmarks-label"],
  "civic-pois": ["civic-pois", "civic-pois-label"],
  "flood-zones": ["flood-zones", "flood-zones-outline", "flood-zones-label"],
  "aqi-points": ["aqi-points", "aqi-labels"],
};
const layerVisibility = {};
function setLayerVisible(layerId, visible) {
  if (!mapInstance) return;
  layerVisibility[layerId] = visible;
  (LAYER_GROUPS[layerId] || [layerId]).forEach(function (id) {
    if (mapInstance.getLayer(id)) mapInstance.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  });
  $$("[data-layer-toggle]").forEach(function (btn) {
    if (btn.dataset.layerToggle !== layerId) return;
    btn.classList.toggle("atlas-toggle--on", visible);
    btn.setAttribute("aria-pressed", String(visible));
  });
}
function setupLayerToggles() {
  $$("[data-layer-toggle]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const id = btn.dataset.layerToggle;
      if (!mapInstance.getLayer(id)) { showToast("This layer is unavailable. See Data & sources."); return; }
      setLayerVisible(id, mapInstance.getLayoutProperty(id, "visibility") === "none");
    });
  });
}

function setBasemap(name) {
  if (!mapInstance || name !== "esri") return;
  currentBasemap = name;
  // Simple basemap toggle: hide Esri when openfreemap is selected.
  const esriVisible = name === "esri" ? "visible" : "none";
  mapInstance.setLayoutProperty("esri-imagery", "visibility", esriVisible);
  $$(".atlas-basemap-btn").forEach(function (b) {
    b.classList.toggle("atlas-basemap-btn--active", b.dataset.bas === name);
    b.setAttribute("aria-pressed", String(b.dataset.bas === name));
  });
}

// ── postMessage bridge to dashboard iframe ────────────────────────────────
function postMsg(type, payload) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        Object.assign({ type: "hcmc-atlas", event: type, source: "atlas" }, payload),
        parentTargetOrigin(),
      );
    }
  } catch (e) {}
}
window.addEventListener("message", function (e) {
  if (PARENT_ORIGINS.indexOf(e.origin) === -1 && e.origin !== window.location.origin) return;
  if (e.source !== window.parent || !mapInstance) return;
  const m = e.data;
  if (!m || typeof m !== "object") return;
  if (m.type === "atlas:flyTo" && m.areaId) flyToArea(m.areaId, { updateHash: false });
  else if (m.type === "atlas:flyover") (m.start ? startFlyover : stopFlyover)();
  else if (m.type === "atlas:setBasemap" && m.bas === "esri") setBasemap(m.bas);
  else if (m.type === "atlas:toggleLayer" && m.layerId && mapInstance.getLayer(m.layerId)) {
    setLayerVisible(m.layerId, m.visible !== false);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  try {
    const r = await fetch(ATLAS_BASE + "/hcmc-areas.json", { cache: "no-store" });
    if (!r.ok) throw new Error("areas fetch failed");
    areasDoc = await r.json();
  } catch (e) {
    console.error("Failed to load areas", e);
    showToast("Quick jump unavailable. You can still explore the map.", 4000);
    areasDoc = { areas: [] };
  }

  renderAreaGrid();
  if (!mapInstance) {
    setToggleLabel("atlas-map-status", "3D map unavailable. Use the text data below or reload to retry.");
    return;
  }
  setupInspect();

  function onMapReady() {
    try {
      applyAllLayers();
    } catch (e) {
      console.error("[atlas] applyAllLayers failed", e);
    }
    setupLayerToggles();
    setBasemap(currentBasemap);
    const params = new URLSearchParams(window.location.search);
    const initial = params.get("area");
    if (initial) flyToArea(initial, { updateHash: false, instant: true });
    refreshLiveOverlay();
    refreshAirQuality();
    applySunLight();
    setInterval(applySunLight, 60000);
    mapInstance.on("moveend", function () { if (orbiting) orbitStep(); });
    ["mousedown", "touchstart", "wheel", "keydown"].forEach(function (ev) {
      document.addEventListener(ev, armIdleOrbit, { passive: true, capture: true });
    });
    armIdleOrbit();

    // Self-test + handshake. Count the layers + sources we just added.
    // If PMTiles failed silently (range 416, CORS block, missing tile
    // header) the source will exist but have 0 features -- emit a console
    // error so the failure is loud, not a silently-blank map. Then tell
    // the parent dashboard "ready" + which build is actually loaded so
    // the dashboard can show a stale-bundle warning when iframe atlas
    // version != the dashboard's pinned BUILD_ID.
    const srcIds = mapInstance.getStyle().sources
      ? Object.keys(mapInstance.getStyle().sources)
      : [];
    const layerIds = mapInstance.getStyle().layers
      ? mapInstance.getStyle().layers.map(function (l) { return l.id; })
      : [];
    const hasBuildings = layerIds.indexOf("hcmc-buildings") !== -1;
    if (!hasBuildings) {
      console.error(
        "[atlas] hcmc-buildings layer is missing after onMapReady -- PMTiles may have failed",
      );
    }
    postMsg("ready", {
      version: ATLAS_BUILD_TAG,
      sources: srcIds,
      layers: layerIds,
      buildingsPresent: hasBuildings,
    });
  }
  // Add layers when the style object exists. `loaded()` waits for every
  // satellite tile, so a slow Esri response never reaches onMapReady and
  // the buildings, buses, and sensor labels never appear. `isStyleLoaded`
  // is the warm path; `style.load` is the cold path.
  styleReady.then(onMapReady);

  const flyoverBtn = document.getElementById("atlas-flyover-btn");
  if (flyoverBtn) {
    flyoverBtn.addEventListener("click", function () {
      if (flyoverTimer) stopFlyover();
      else startFlyover();
    });
  }

  $$(".atlas-basemap-btn").forEach(function (b) {
    b.addEventListener("click", function () { setBasemap(b.dataset.bas); });
  });
}

boot().catch(function (e) {
  console.warn("[atlas] startup failed:", e.message);
  setToggleLabel("atlas-map-status", "Map startup failed. Reload to retry; use the text data below.");
});
refreshLiveOverlay();
refreshAirQuality();
loadReferenceText();
setInterval(function () { refreshLiveOverlay(); refreshAirQuality(); }, 60000);
document.getElementById("atlas-orbit-btn")?.addEventListener("click", function (e) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { showToast("Orbit paused for reduced motion."); return; }
  orbitEnabled = !orbitEnabled;
  e.currentTarget.setAttribute("aria-pressed", String(orbitEnabled));
  e.currentTarget.textContent = orbitEnabled ? "Pause orbit" : "Enable orbit";
  if (!orbitEnabled && mapInstance) mapInstance.stop();
  armIdleOrbit();
});