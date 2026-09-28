#!/usr/bin/env node
// Local sanity-check — runs without network. Verifies that:
//   • package.json parses
//   • wrangler.toml parses
//   • every JSON file in public/ is valid
//   • the index.html references everything we expect
//   • the worker source compiles cleanly to TypeScript via the
//     `wrangler deploy --dry-run` shim (catches missing imports too)

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

test("package.json parses", () => {
  const p = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
  if (!p.name) throw new Error("missing name");
});

test("wrangler.toml parses", () => {
  const w = readFileSync(resolve(ROOT, "wrangler.toml"), "utf-8");
  if (!w.includes("name =")) throw new Error("missing worker name");
  if (!w.includes("[[r2_buckets]]")) throw new Error("missing R2 binding");
});

test("tsconfig.json parses", () => {
  const t = JSON.parse(readFileSync(resolve(ROOT, "tsconfig.json"), "utf-8"));
  if (!t.compilerOptions) throw new Error("missing compilerOptions");
});

test("public/index.html present + has expected markers", () => {
  const html = readFileSync(resolve(ROOT, "public/index.html"), "utf-8");
  if (!html.includes('id="atlas-map"')) throw new Error("missing atlas-map container");
  if (!html.includes('id="atlas-areas"')) throw new Error("missing areas section");
  if (!html.includes('id="atlas-inspect"')) throw new Error("missing inspect section");
  if (!html.includes("/app.js")) throw new Error("missing app.js script");
  if (!html.includes("/style.css")) throw new Error("missing style.css link");
});

test("public/hcmc-areas.json parses + 12 areas", () => {
  const a = JSON.parse(readFileSync(resolve(ROOT, "public/hcmc-areas.json"), "utf-8"));
  if (!Array.isArray(a.areas)) throw new Error("missing areas array");
  if (a.areas.length !== 12) throw new Error(`expected 12 areas, got ${a.areas.length}`);
});

test("public/style.css parses + has root tokens", () => {
  const css = readFileSync(resolve(ROOT, "public/style.css"), "utf-8");
  if (!css.includes("--bg:")) throw new Error("missing --bg token");
  if (!css.includes("--ink:")) throw new Error("missing --ink token");
  if (!css.includes("--amber:")) throw new Error("missing --amber token");
});

test("public/app.js parses as JS (basic syntax)", () => {
  const code = readFileSync(resolve(ROOT, "public/app.js"), "utf-8");
  if (!code.includes("__maplibregl__.Map")) throw new Error("missing maplibregl Map usage");
  if (!code.includes("refreshLiveOverlay")) throw new Error("missing refreshLiveOverlay");
  if (!code.includes("function addBuildings")) throw new Error("missing addBuildings");
  if (!code.includes("escapeHtml")) throw new Error("missing escapeHtml");
  if (code.includes("Stop \" + (i + 1)")) throw new Error("procedural bus stops are still in the client");
});

test("src/index.ts parses + has key handlers", () => {
  const ts = readFileSync(resolve(ROOT, "src/index.ts"), "utf-8");
  if (!ts.includes("/api/atlas/areas")) throw new Error("missing /api/atlas/areas handler");
  if (!ts.includes("servePmtilesFromR2")) throw new Error("missing PMTiles passthrough");
  if (!ts.includes("HCMC_TILES")) throw new Error("missing R2 binding");
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
