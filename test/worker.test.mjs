// Node >=22.18 strips this Worker's TypeScript. No network or R2 account needed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import worker from '../src/index.ts';

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('External requests forbidden in offline tests'); };
after(() => { globalThis.fetch = originalFetch; });
const data = Uint8Array.from({ length: 256 }, (_, i) => i);
const key = 'buildings/hcmc-v3.pmtiles';
const env = {
  ASSETS: { async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== '/hcmc-areas.json') return new Response('local asset', { status: 200 });
    return new Response(await readFile(new URL('../public/hcmc-areas.json', import.meta.url)));
  } },
  HCMC_TILES: {
    async head(name) { return name === key ? { size: data.length } : null; },
    async get(name, options) {
      if (name !== key) return null;
      const { offset = 0, length = data.length } = options?.range ?? {};
      return { size: data.length, body: data.slice(offset, offset + length), httpEtag: '"fixture"' };
    },
  },
};
const request = (path, init, bindings = env) => worker.fetch(new Request(`http://localhost${path}`, init), bindings, {});

test('curated areas and category filtering', async () => {
  const all = await (await request('/api/atlas/areas')).json();
  assert.equal(all.count, 12);
  const category = all.areas[0].category;
  const filtered = await (await request(`/api/atlas/areas?category=${category}`)).json();
  assert.ok(filtered.count > 0);
  assert.ok(filtered.areas.every(a => a.category === category));
});
test('six curated corridors', async () => {
  assert.equal((await (await request('/api/atlas/corridors')).json()).corridors.length, 6);
});
test('district source is explicitly static', async () => {
  assert.equal((await (await request('/api/atlas/districts')).json()).source.tier, 'static');
});
test('invalid and outside coordinates fail before any upstream call', async () => {
  for (const query of ['lng=abc&lat=xyz', 'lng=0&lat=0']) {
    assert.equal((await request(`/api/atlas/at-this-point?${query}`)).status, 400);
  }
});
test('building API gives a pointer, not fabricated geometry', async () => {
  const result = await (await request('/api/atlas/buildings?limit=99999')).json();
  assert.equal(result.pointer.r2Key, key);
  assert.equal(result.limit, 5000);
  assert.match(result.note, /isn't wired/);
});
test('health shows missing tiles separately from liveness', async () => {
  const result = await (await request('/api/health', undefined, { ...env, HCMC_TILES: { head: async () => null } })).json();
  assert.equal(result.ok, true);
  assert.equal(result.pmtiles.available, false);
});
test('byte range returns exact bytes and CORS headers, including with a cache buster', async () => {
  const response = await request('/hcmc-buildings.pmtiles?v=test', { headers: { Range: 'bytes=0-127' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-127/256');
  assert.equal(response.headers.get('vary'), 'Range');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data.slice(0, 128));
});
test('suffix and overlong ranges are clamped', async () => {
  for (const [range, expected] of [['bytes=-16', 'bytes 240-255/256'], ['bytes=250-999', 'bytes 250-255/256']]) {
    const response = await request('/hcmc-buildings.pmtiles', { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), expected);
  }
});
test('out-of-bounds range is 416', async () => {
  const response = await request('/hcmc-buildings.pmtiles', { headers: { Range: 'bytes=256-300' } });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), 'bytes */256');
});
test('missing archive is 404', async () => {
  assert.equal((await request('/hcmc-waterways.pmtiles')).status, 404);
});
test('preflight and unsupported methods', async () => {
  assert.equal((await request('/api/atlas/areas', { method: 'OPTIONS' })).status, 204);
  assert.equal((await request('/api/atlas/areas', { method: 'POST' })).status, 405);
});
test('static response is passed through with CORS', async () => {
  const response = await request('/');
  assert.equal(await response.text(), 'local asset');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});
