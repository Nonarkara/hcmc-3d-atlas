#!/usr/bin/env node
// Stamps the asset-cache-buster version into public/index.html so the
// dashboard's iframe (and any browser caching the atlas URL) always pulls
// the latest app.js / style.css after a deploy. Also writes the build tag
// into public/app.js so the atlas can broadcast its identity to the
// dashboard's iframe parent via postMessage.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = join(__dirname, "..", "public", "index.html");
const appJs = join(__dirname, "..", "public", "app.js");

let sha = "local";
try {
  sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {}

const now = new Date();
const stamp = `hcmc-atlas-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}-${Math.floor(now.getTime() / 1000)}-${sha}`;

const html = readFileSync(indexHtml, "utf8");
const nextHtml = html
  .replace(/href="\/style\.css\?v=[^"]*"/g, `href="/style.css?v=${stamp}"`)
  .replace(/src="\/app\.js\?v=[^"]*"/g, `src="/app.js?v=${stamp}"`);

writeFileSync(indexHtml, nextHtml, "utf8");

const js = readFileSync(appJs, "utf8");
const nextJs = js.replace(
  /const ATLAS_BUILD_TAG = "[^"]*";/,
  `const ATLAS_BUILD_TAG = "${stamp}";`,
);
writeFileSync(appJs, nextJs, "utf8");

console.log(`[stamp-build-id] wrote ${stamp} into index.html and app.js`);