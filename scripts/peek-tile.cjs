const { PMTiles } = require("pmtiles");
const { VectorTile } = require("@mapbox/vector-tile");
const Pbf = require("pbf");
const { gunzipSync } = require("zlib");

(async () => {
  const p = new PMTiles("https://hcmc-3d-atlas.drnon.workers.dev/hcmc-buildings.pmtiles");
  const z = 15;
  const lon = 106.702;
  const lat = 10.7718;
  const x = Math.floor(((lon + 180) / 360) * 2 ** z);
  const n = Math.sin((lat * Math.PI) / 180);
  const y = Math.floor((1 - Math.log((1 + n) / (1 - n)) / (2 * Math.PI)) * 2 ** (z - 1));
  const tile = await p.getZxy(z, x, y);
  let buf = Buffer.from(tile.data);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  const vt = new VectorTile(new Pbf(buf));
  const layer = vt.layers.buildings;
  const heights = [];
  const named = [];
  for (let i = 0; i < layer.length; i++) {
    const props = layer.feature(i).properties;
    heights.push(Number(props.render_height));
    if (props.name) named.push(`${props.name}:${props.render_height}`);
  }
  heights.sort((a, b) => a - b);
  const nFeat = heights.length;
  console.log(JSON.stringify({
    n: nFeat,
    min: heights[0],
    p50: heights[nFeat >> 1],
    p90: heights[Math.floor(nFeat * 0.9)],
    max: heights[nFeat - 1],
    zero: heights.filter((h) => !h).length,
    named: named.slice(0, 20),
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
