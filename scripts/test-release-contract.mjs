import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const worker = (await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))).default;
const originalFetch = globalThis.fetch, originalCaches = globalThis.caches;
const current = new Date().toISOString();
let feeds = {};
let head = { size: 1000, httpEtag: '"atlas"' }, reads = 0;
const env = {
  ASSETS: { fetch: async () => Response.json({ areas: [{ center: [106.7, 10.78] }], corridors: [] }) },
  HCMC_TILES: { head: async () => head, get: async (_key, options) => { reads++; return { body: new Uint8Array(options?.range?.length ?? 1000), size: 1000 }; } },
};
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
globalThis.fetch = async url => {
  const data = feeds[new URL(url).pathname];
  return data === undefined ? new Response(null, { status: 503 }) : Response.json(data);
};
const request = (path, options) => worker.fetch(new Request('https://atlas.test' + path, options), env, {});
try {
  for (const query of ['lng=106.7oops&lat=10.78', 'lng=&lat=', 'lng=106.7&lat=10.78no']) assert.equal((await request('/api/risk?' + query)).status, 400);
  for (const path of ['/api/atlas/areas', '/api/atlas/buildings']) {
    for (const bbox of ['bad', '107,11,106,10', '106,,107,11', '106,10,107,100']) assert.equal((await request(path + '?bbox=' + bbox)).status, 400);
  }
  let response = await request('/api/risk?lng=106.7&lat=10.78');
  let risk = await response.json();
  assert.equal(risk.score, null); assert.equal(risk.band, 'unavailable');
  assert.deepEqual(risk.omitted, ['flood', 'pm25', 'wind']);
  feeds = {
    '/api/air-quality': [{ lng: 106.7, lat: 10.78, aqi: 50, pm25: 10, observedAt: current }],
    '/api/weather/ops': { rainfallMm: 0, windKph: 0, sourceSummary: { freshness: { observedAt: current } } },
    '/api/hcmc/sensors': { sensors: [] },
  };
  risk = await (await request('/api/risk?lng=106.7&lat=10.78')).json();
  assert.equal(risk.score, 0); assert.equal(risk.factors.waterFrom, 'rainfall');
  feeds['/api/weather/ops'].sourceSummary.freshness.observedAt = new Date(Date.now() + 7 * 3600000).toISOString();
  risk = await (await request('/api/risk?lng=106.7&lat=10.78')).json();
  assert.equal(risk.score, null, 'future weather time cannot establish low risk');
  feeds['/api/weather/ops'].sourceSummary.freshness.observedAt = current;
  feeds['/api/air-quality'][0].observedAt = '2026-01-01T00:00:00Z';
  risk = await (await request('/api/risk?lng=106.7&lat=10.78')).json();
  assert.equal(risk.score, null); assert.ok(risk.omitted.includes('pm25'));
  feeds['/api/hcmc/sensors'] = { sensors: 'bad' };
  assert.equal((await request('/api/traffic')).status, 200);
  feeds['/api/air-quality'] = [null, { lng: null, lat: 10.78, aqi: 0 }, { lng: 106.7, lat: 10.78, aqi: null }];
  assert.equal((await request('/api/atlas/air-quality')).status, 503, 'invalid data never becomes zero AQI');
  const events = await (await request('/api/atlas/city-events')).json();
  assert.match(events.ingestWarning, /unavailable/);
  response = await request('/hcmc-buildings.pmtiles', { method: 'HEAD' });
  assert.equal(response.status, 200); assert.equal(reads, 0); assert.equal(await response.text(), '');
  response = await request('/hcmc-buildings.pmtiles', { headers: { range: 'bytes=995-1100' } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 995-999/1000');
  assert.equal((await response.arrayBuffer()).byteLength, 5);
  response = await request('/hcmc-buildings.pmtiles', { headers: { range: 'bytes=1000-' } });
  assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */1000');
  response = await request('/hcmc-buildings.pmtiles', { headers: { range: 'bytes=-10' } });
  assert.equal(response.headers.get('content-range'), 'bytes 990-999/1000');
  head = null;
  response = await request('/api/health');
  assert.equal(response.status, 503); assert.equal((await response.json()).ok, false);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors/);
  assert.equal((await request('/api/traffic', { method: 'POST' })).status, 405);
} finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
console.log('PASS release contract: input validation, incomplete/stale risk, malformed feeds, outage truth, HEAD, Range, health and headers');
