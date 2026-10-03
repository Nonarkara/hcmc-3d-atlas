# Shipability, professionalism, and credibility audit

Date: 2 October 2026 (ICT). Scope: the HCMC atlas repository and its custom-domain deployment. This is an audit of a public demo, not a certification of operational readiness.

## Release requirements and findings

| Requirement | Finding and action | Verification |
| --- | --- | --- |
| Preserve the working city | All map sources and curated content retained. Extrusions remain in metre units. | Static height/race regression checks; live tile and visual checks. |
| Claims match the data | Removed the claim that every height is measured and that every overlay is live. Header identifies the demo; text ledger explains estimates and geometry limits. | Baked stats and live PMTiles metadata checked against page copy. |
| Source, tier, and age accompany values | Sensor and AQI tables expose source and observation age in ICT. Modeled AQI is labeled. Missing/invalid AQI is not coerced to zero. | Client contract tests, rendered source ledger. |
| Reference data is distinguishable | Flood polygons are approximate atlas sketches; metro alignment is schematic. Landmark parts are curated models. Legacy district statistics explicitly have unverified dates. Blanket CC-BY assertion removed. | Files examined; source documentation linked. |
| Failure is visible | Text ledger loads without WebGL/CDN libraries. Failed feeds are unavailable or visibly last retrieved. Missing archive makes health fail. Empty incident feed does not mean no incidents. | Client fallback and Worker outage tests. |
| Risk does not imply safety from absent evidence | Missing, stale, and future-dated components produce `score: null`, `band: unavailable`, and explicit omissions. Only fresh water-level sensors count as flood alerts. | Worker behavioral tests for absent/stale/future inputs. |
| Interaction is complete | Toggles include outlines/labels and expose `aria-pressed`. Native quick-jump buttons retain button semantics. Building feature state includes the vector source layer. Landmark clicks expose model provenance. Inspector closes by button or Escape. | Client behavioral tests and browser walkthrough. |
| Motion can be controlled | Idle orbit is opt-in and can be paused. Reduced-motion jumps to places; flyover is explicitly user-started and can be stopped. | Behavioral tests and browser walkthrough. |
| Mobile and keyboard operation | Visible focus, 44 px controls, scrollable layer panel, constrained inspect panel, semantic data tables. | Browser checks at 390 px and 320 px; keyboard operation; automated accessibility check recorded below. |
| Deployment proves its bytes | Preferred script now stamps assets, runs local gates, and verifies the deployed tag. | Exact-build smoke check, custom-domain checks. |
| Security and dependencies | Pinned CDN assets have SRI; CSP permits only required sources and the dashboard embed. Added nosniff, referrer and permissions headers. Updated Wrangler and matching types to support the configured runtime date. | Typecheck, tests, npm audit and live headers. |

## Evidence and limits

The local bake stats sum to 4,013,181 input building features: 360 tagged heights, 3,878 floor-count estimates, 3,195,695 Google 2.5D estimates, 418,807 GHSL estimates, and 394,441 defaults. Live archive metadata reports zoom 12–15, and records dropping/thinning at lower zooms and small-polygon omission at higher zooms. “Every building” was an unsupported completeness claim.

Open-Meteo's [air-quality documentation](https://open-meteo.com/en/docs/air-quality-api) describes modeled hourly forecasts and requires provider attribution. [Overture's buildings documentation](https://docs.overturemaps.org/guides/buildings/) and [attribution page](https://docs.overturemaps.org/attribution/) establish source-specific credits and ODbL treatment for buildings. These references support the revised claims; this audit is not a legal determination of all redistribution rights.

The prescribed `npx axiom-audit . --strict` could not run: the npm registry returned 404 for `axiom-audit`, and no local executable was found. This gate is unverified; no passing result is claimed. Source checks and browser review are recorded separately.

## Remaining gaps before an operational pilot

- VNTT observations supplied by `/api/hcmc/sensors` date from 25 June 2026. The separate preview endpoint supplies modeled readings. A real ingestion path and observation-age SLA are needed.
- Bus positions are simulated. Operational tracking requires a verified real-time source, with coverage and outage reporting.
- The dashboard weather feed supplies a UTC timestamp seven hours ahead of retrieval time. The atlas rejects that time for risk scoring; the source timezone error remains upstream.
- Flood polygons lack surveyed geometry and per-feature source URLs/dates. They remain indicative and must not be used as live inundation extents.
- Landmark total-height references do not verify every modeled building part. A surveyed skyline requires part-level evidence.
- Legacy district area/population figures have unverified source dates. Current administrative boundaries and official statistics require separate sourcing.
- No end-to-end ingestion SLA, official warning integration, physical-device field validation, or sustained performance/load benchmark has been established. Automated checks do not establish those properties.

These gaps are visible in the product or API. The proper next milestone is verified ingestion and reference sourcing, not more live-looking decoration.

## Verification record

Local verification: TypeScript passed; 12 source checks and all four behavioral test suites passed. Theme contrast tests cover all three appearances (body text 11.54:1 dark/light, 17.31:1 high contrast). Browser review confirmed rendered buildings with MapLibre 6.4.1, appearance switching and 320 px reflow without horizontal overflow. Installed-package npm audit reported zero advisories. CDN dependency review separately found GHSA-jrc7-96c5-q579 affecting the former MapLibre 4.7.1; the patched 6.4.1 module and its BSD license are now vendored locally.

Palette plate 325 supplies the lacquer red, ochre, pale yellow and deep green source colors. Screen adaptations suggest Vietnamese yellow plaster and lacquer; they do not claim a historical Vietnamese origin for Wada’s palette. Palette attribution and source licenses are recorded in THIRD_PARTY_NOTICES.md.

Release verification is performed by deploy:live against the exact stamped build, archive Range responses and API contracts. An independent automated accessibility audit, human usability test and physical-device test remain unverified.
