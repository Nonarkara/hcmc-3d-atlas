import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const files = name => JSON.parse(readFileSync(new URL('../public/' + name, import.meta.url), 'utf8'));
const current = new Date().toISOString();
const feeds = {
  '/hcmc-areas.json': files('hcmc-areas.json'),
  '/hcmc-landmarks.geojson': files('hcmc-landmarks.geojson'),
  '/hcmc-flood-zones.geojson': files('hcmc-flood-zones.geojson'),
  '/api/traffic': { sensors: [{ id: 'canal', label: 'Canal <gauge>', unit: 'cm', value: 0, stale: true, lng: 106.7, lat: 10.78 }], buses: [], provenance: { sensors: { tier: 'reference', source: 'VNTT' }, buses: { tier: 'simulated' } } },
  '/api/atlas/air-quality': [{ label: 'District 1', aqi: 79, pm25: 33.9, lng: 106.7, lat: 10.78, observedAt: current, source: 'Open-Meteo', provenance: { tier: 'live', source: 'Open-Meteo / CAMS' } }],
};
function element() {
  return { dataset: {}, hidden: false, style: {}, textContent: '', innerHTML: '', listeners: {}, attrs: {}, children: [],
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, cb) { this.listeners[k] = cb; }, appendChild(el) { this.children.push(el); } };
}
class FakeMap {
  constructor(options) { this.style = { _loaded: true }; this.sources = { ...options.style.sources }; this.layers = Object.fromEntries(options.style.layers.map(l => [l.id, { ...l, layout: {} }])); this.handlers = []; this.states = []; }
  resize() {} addControl() {} setLight() {} moveLayer() {} stop() {}
  addSource(id, source) { this.sources[id] = { ...source, setData(data) { this.data = data; } }; }
  addLayer(layer) { this.layers[layer.id] = { ...layer, layout: { ...layer.layout } }; }
  getLayer(id) { return this.layers[id]; } getSource(id) { return this.sources[id]; }
  getLayoutProperty(id, prop) { return this.layers[id]?.layout?.[prop]; }
  setPaintProperty(id, prop, value) { this.layers[id].paint[prop] = value; }
  setLayoutProperty(id, prop, value) { this.layers[id].layout[prop] = value; }
  getStyle() { return { sources: this.sources, layers: Object.values(this.layers) }; }
  isStyleLoaded() { return true; } loaded() { return true; }
  on(...args) { this.handlers.push(args); } once() {}
  setFeatureState(target, state) { this.states.push({ target, state }); }
  getCanvas() { return { style: {} }; } queryRenderedFeatures() { return []; }
  jumpTo() { this.jumped = true; } flyTo() { this.flew = true; }
}
async function scenario(mode) {
  const elements = new Map(), listeners = {}, messages = [];
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const toggles = ['hcmc-buildings', 'flood-zones', 'hcmc-landmarks-3d', 'aqi-points'].map(id => { const el = element(); el.dataset.layerToggle = id; return el; });
  const parent = { postMessage: payload => messages.push(payload) };
  const window = { location: { origin: 'https://atlas.test', href: 'https://atlas.test', search: '' }, parent,
    matchMedia: () => ({ matches: true }), addEventListener: (event, cb) => { listeners[event] = cb; } };
  if (mode !== 'missing-libraries') {
    window.maplibregl = { Map: mode === 'webgl-failure' ? class { constructor() { throw new Error('No WebGL'); } } : FakeMap, addProtocol() {}, NavigationControl: class {}, ScaleControl: class {} };
    window.pmtiles = { Protocol: class {} };
  }
  const context = vm.createContext({ window, document: { documentElement: { dataset: { theme: "dark" } }, referrer: '', body: element(), getElementById: get,
    createElement: element, querySelectorAll: selector => selector === '[data-layer-toggle]' ? toggles : [], querySelector: () => null, addEventListener() {} },
    console: { error() {}, warn() {} }, history: { replaceState() {} }, URL, URLSearchParams, AbortSignal,
    fetch: async path => Response.json(feeds[path]), requestAnimationFrame: cb => cb(),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(app, context);
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.match(get('atlas-sensor-rows').innerHTML, /0\.0 cm/);
  assert.match(get('atlas-sensor-rows').innerHTML, /Canal &lt;gauge&gt;/);
  assert.match(get('atlas-sensor-rows').innerHTML, /Stale/);
  assert.match(get('atlas-aqi-rows').innerHTML, /modeled/);
  assert.match(get('atlas-reference-list').innerHTML, /Landmark 81/);
  if (mode !== 'normal') assert.match(get('atlas-map-status').textContent, /unavailable/);
  else {
    const map = vm.runInContext('mapInstance', context);
    assert.ok(map.getLayer('hcmc-buildings')); assert.ok(map.getLayer('hcmc-landmarks-3d'));
    assert.equal(map.getSource('hcmc-aqi-src').data.features.length, 1);
    vm.runInContext('setLayerVisible("flood-zones", false)', context);
    for (const id of ['flood-zones', 'flood-zones-outline', 'flood-zones-label']) assert.equal(map.getLayoutProperty(id, 'visibility'), 'none');
    assert.equal(toggles[1].attrs['aria-pressed'], 'false');
    const handler = map.handlers.find(args => args[0] === 'click' && args[1] === 'hcmc-buildings')[2];
    handler({ features: [{ id: 7, properties: { h: 10, hs: 'estimated' } }], lngLat: { lng: 106.7, lat: 10.78 } });
    assert.equal(map.states.at(-1).target.sourceLayer, 'buildings');
    assert.match(get('atlas-inspect-props').innerHTML, /unknown/);
    assert.match(get('atlas-inspect-props').innerHTML, /no measurement/);
    const ready = messages.find(m => m.event === 'ready');
    assert.ok(ready?.buildingsPresent);
    const visibility = map.getLayoutProperty('hcmc-buildings', 'visibility');
    listeners.message({ origin: 'https://atlas.test', source: {}, data: { type: 'atlas:toggleLayer', layerId: 'hcmc-buildings', visible: false } });
    assert.equal(map.getLayoutProperty('hcmc-buildings', 'visibility'), visibility, 'only the parent may command the map');
    vm.runInContext('flyToArea("district-1-cbd")', context);
    assert.equal(map.jumped, true, 'reduced motion uses jumpTo');
  }
}
for (const mode of ['normal', 'missing-libraries', 'webgl-failure']) await scenario(mode);
console.log('PASS client contract: map bootstrap, grouped layers, provenance text, zero values, escaping, WebGL/CDN fallback, feature selection, bridge and reduced motion');
