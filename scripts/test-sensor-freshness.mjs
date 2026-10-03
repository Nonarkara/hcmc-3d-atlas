import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const worker = (await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))).default;
const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
let feed;
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
globalThis.fetch = async url => Response.json(String(url).endsWith('/api/hcmc/sensors') ? feed : {});
try {
  for (const [stamp, stale] of [[new Date().toISOString(), false], ['2026-06-25T08:09:47Z', true], ['invalid', true], [null, true]]) {
    feed = { sensors: [{ id: 'gauge', name: 'Canal gauge', unit: 'cm', lng: 106.7, lat: 10.78, latestReading: { value: 23, status: 'normal', observedAt: stamp } }] };
    const res = await worker.fetch(new Request('https://atlas.test/api/traffic'), {}, {});
    const data = await res.json();
    assert.equal(data.sensors[0].stale, stale);
    assert.equal(data.sensorFreshness.stale, stale);
    assert.equal(data.sensors[0].value, 23);
    assert.equal(data.sensors[0].unit, 'cm');
  }
  feed.sensors.push({ id: 'fresh', latestReading: { observedAt: new Date().toISOString() } });
  const mixed = await (await worker.fetch(new Request('https://atlas.test/api/traffic'), {}, {})).json();
  assert.equal(mixed.sensorFreshness.stale, false);
  assert.equal(mixed.sensors[0].stale, true, 'fresh station must not freshen another station');
} finally {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
}

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
assert.equal(app.includes('/api/hcmc/vntt-sensors'), false, 'no second sensor writer');
const observationHelpers = app.slice(app.indexOf('function observationStale('), app.indexOf('function evidenceCell('));
const refresh = app.slice(app.indexOf('async function refreshLiveOverlay()'), app.indexOf('// ── Areas + flyTo'));
let geojson, label;
const context = vm.createContext({
  fetchLive: async () => ({ sensors: [{ id: 'old', status: 'normal', stale: true, lng: 106.7, lat: 10.78 }, { id: 'bad', lng: null, lat: 10.78 }], buses: [], sensorFreshness: { stale: true } }),
  mapInstance: { getSource: id => id === 'live-sensors-src' ? { setData: data => { geojson = data; } } : null },
  liveSensors: {},
  renderSensorTable: () => {},
  setToggleLabel: (id, text) => { if (id === 'atlas-sensor-label') label = text; },
});
await vm.runInContext(observationHelpers + refresh + '\nrefreshLiveOverlay()', context);
assert.equal(geojson.features.length, 1);
assert.equal(geojson.features[0].properties.status, 'stale');
assert.equal(label, 'VNTT sensors · stale');
console.log('PASS sensor freshness: fresh, old, missing, invalid, mixed stations, map status and single writer');
