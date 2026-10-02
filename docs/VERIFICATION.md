# Verification record

Checked on 2026-10-02 in a Linux x64 environment with Node 24.19.0 and npm 11.9.0, against source baseline `f9920203c0887199b3cd43c10f8d98af23d679dc` plus the local documentation/readiness changes.

## Passed

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/public-readiness-undocumented-npm-cache` | Locked dependencies installed, no lifecycle scripts run |
| `npm run verify` | 12/12 committed-data and source-invariant sanity checks |
| `npm run typecheck` | TypeScript exited 0 |
| `npm test` | 12/12 offline Worker contract tests; synthetic R2 bytes; external fetch blocked |
| `WRANGLER_SEND_METRICS=false XDG_CONFIG_HOME=/tmp/undocumented-wrangler npm run build:check` | Wrangler bundle dry run exited 0; no upload |
| `node --check public/app.js` | JavaScript syntax |
| `git diff --check` | No whitespace errors |

All four documentation SVGs across this two-repository batch were parsed as XML, rendered with Sharp, and visually inspected. Local Markdown target files were checked for existence. The artwork is not a browser screenshot.

## Blocked / failed attempts

- The initial dependency installation failed because the environment's default npm cache was unwritable. Retrying with a writable temporary cache succeeded; lockfile dependency versions were not changed
- Local runtime smoke using `node node_modules/wrangler/bin/wrangler.js dev --local --config wrangler.local.toml --ip 127.0.0.1 --port 18787` failed before listening with `uv_interface_addresses returned Unknown system error 1`. The local HTTP route checks were therefore not run against a live Wrangler instance. This environment failure is not a passing runtime test

## Not run

- Real PMTiles decoding, tile geometry/count/height verification, or local R2 seeding: archives are not committed
- Browser/WebGL rendering, interaction, iframe communication, or visual regression testing
- Existing `smoke` / `smoke:api` integration commands: they reach live services by default and require data outside this checkout
- Upstream freshness, public availability, satellite/Overture/GHSL extraction, landmark re-curation
- Full dependency vulnerability audit, load testing, production configuration changes, uploads, deployment, or provider billing actions

The checks establish source/build and mocked protocol behavior, not complete reproducibility of the production city. To finish acceptance on another machine, start the local Worker, seed reviewed archives, test Range responses, then inspect the browser with the intended external sources available.
