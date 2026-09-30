#!/usr/bin/env python3
"""
bake-buildings.py — Overture Maps buildings → HCMC 3D PMTiles.

Conservation law: every footprint in the bbox is drawn once, at a height in
real metres, and says where that height came from:
  measured  = Overture `height` (OSM tag or survey)
  floors    = Overture `num_floors` × 3.3 m
  satellite = GHSL built-up height (EU JRC, Sentinel-2 + DEM, 2018): the
              average building height of the footprint's 100 m cell
  estimated = class default (the cell has no built-up signal)
No multiplier. A 10 m tube house is drawn 10 m tall.
Overture has a height for ~0.1% of HCMC footprints, so without GHSL the
city would be a flat carpet; with it CBD blocks rise and suburbs stay low.

Overture merges OpenStreetMap + Microsoft ML + Google Open Buildings
footprints (satellite-derived), so coverage is far denser than OSM alone.
Buildings with `has_parts` are replaced by their `building_part` rows, which
carry `min_height` — that is what gives towers a stepped silhouette.

Usage:
  python3 scripts/bake-buildings.py extract   # Overture S3 → out/overture-*.parquet (slow, once)
  python3 scripts/bake-buildings.py bake      # parquet → out/hcmc-buildings-v2.pmtiles
  npx wrangler r2 object put hcmc-tiles/buildings/hcmc-v2.pmtiles \
      --file out/hcmc-buildings-v2.pmtiles --remote

Data: © OpenStreetMap contributors (ODbL), Microsoft (ODbL), Google (CC BY 4.0 / ODbL),
via Overture Maps Foundation. Heights: GHS-BUILT-H R2023A, European Commission JRC (CC BY 4.0).
"""
import json
import subprocess
import sys
from pathlib import Path

import urllib.request
import zipfile

import duckdb
import rasterio
from rasterio.windows import from_bounds
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

RELEASE = "2026-09-23.1"
BBOX = (106.30, 10.35, 107.05, 11.20)  # matches ATLAS_BBOX_* in wrangler.toml
OUT = Path(__file__).resolve().parent.parent / "out"
S3 = f"s3://overturemaps-us-west-2/release/{RELEASE}/theme=buildings/type="
GHSL_TILE = "GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_4326_3ss_V1_0_R8_C29"  # 100–110 E, 9–19 N
GHSL_URL = ("https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_H_GLOBE_R2023A/"
            f"GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_4326_3ss/V1-0/tiles/{GHSL_TILE}.zip")

# Heights for footprints no source measured. HCMC's fabric is 3–5 storey
# tube houses, so 10 m is the honest median, not a flat 9 m.
CLASS_HEIGHT = {
    "apartments": 30, "hotel": 30, "office": 30, "commercial": 15, "retail": 10,
    "hospital": 20, "university": 18, "college": 18, "school": 12,
    "industrial": 10, "warehouse": 10, "house": 10, "residential": 10,
    "detached": 8, "terrace": 12, "religious": 15, "temple": 15, "pagoda": 18,
    "church": 20, "cathedral": 36, "garage": 4, "shed": 4, "roof": 5,
    "parking": 12, "stadium": 25, "train_station": 15, "transportation": 12,
}
DEFAULT_HEIGHT = 10.0
SRC_CODE = {"OpenStreetMap": "osm", "Microsoft ML Buildings": "ms", "Google Open Buildings": "google"}


def con():
    c = duckdb.connect()
    c.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    return c


def extract():
    OUT.mkdir(exist_ok=True)
    tif = OUT / "ghsl" / f"{GHSL_TILE}.tif"
    if not tif.exists():
        print("download GHSL built-up height tile", flush=True)
        z = OUT / f"{GHSL_TILE}.zip"
        urllib.request.urlretrieve(GHSL_URL, z)
        zipfile.ZipFile(z).extract(f"{GHSL_TILE}.tif", OUT / "ghsl")
    x0, y0, x1, y1 = BBOX
    where = f"bbox.xmin >= {x0} AND bbox.xmax <= {x1} AND bbox.ymin >= {y0} AND bbox.ymax <= {y1}"
    c = con()
    for kind, extra in (
        ("building", "class, has_parts"),
        ("building_part", "NULL AS class, min_height, building_id"),  # parts carry no class
    ):
        dst = OUT / f"overture-{kind}.parquet"
        if dst.exists() and dst.stat().st_size > 0:
            print(f"keep {dst.name} (delete it to re-extract)")
            continue
        print(f"extract {kind} → {dst}", flush=True)
        c.execute(f"""
            COPY (
              SELECT id, geometry, height, num_floors,
                     names.primary AS name, sources[1].dataset AS src, {extra}
              FROM read_parquet('{S3}{kind}/*', hive_partitioning=1)
              WHERE {where}
            ) TO '{dst}' (FORMAT parquet)
        """)
        print(" ", c.execute(f"SELECT count(*) FROM '{dst}'").fetchone()[0], "rows", flush=True)


class Ghsl:
    """Average net building height per 3-arcsecond (~100 m) cell."""

    def __init__(self):
        with rasterio.open(OUT / "ghsl" / f"{GHSL_TILE}.tif") as r:
            win = from_bounds(*BBOX, transform=r.transform).round_offsets().round_lengths()
            self.a = r.read(1, window=win)
            self.t = r.window_transform(win)

    def at(self, x, y):
        col, row = ~self.t * (x, y)
        row, col = int(row), int(col)
        if 0 <= row < self.a.shape[0] and 0 <= col < self.a.shape[1]:
            return float(self.a[row, col])
        return 0.0


def height_of(h, floors, cls, sat):
    if h is not None and 1 <= h <= 500:
        return round(h, 1), "measured"
    if floors is not None and 1 <= floors <= 120:
        return round(floors * 3.3, 1), "floors"
    # A cell average, so cap it: one footprint above 60 m needs a measured source.
    if sat >= 3:
        return round(min(sat, 60.0), 1), "satellite"
    return float(CLASS_HEIGHT.get(cls or "", DEFAULT_HEIGHT)), "estimated"


def landmark_index():
    """Curated landmarks draw themselves; Overture's copy of the same tower
    would z-fight with them, so footprints inside a landmark are skipped."""
    path = OUT.parent / "public" / "hcmc-landmarks.geojson"
    polys = [shape(f["geometry"]).buffer(0.00003) for f in json.loads(path.read_text())["features"]]
    return STRtree(polys), polys


def bake():
    c = con()
    tree, lm = landmark_index()
    ghsl = Ghsl()
    skipped = 0
    geojsonl = OUT / "hcmc-buildings-v2.geojsonl"
    stats = {"measured": 0, "floors": 0, "satellite": 0, "estimated": 0}
    srcs = {}
    n = 0
    cols = "ST_AsGeoJSON(geometry), ST_X(ST_Centroid(geometry)), ST_Y(ST_Centroid(geometry)), height, num_floors, class, name, src"
    queries = [
        f"SELECT {cols}, 0.0 FROM '{OUT}/overture-building.parquet' WHERE NOT coalesce(has_parts, false)",
        f"SELECT {cols}, coalesce(min_height, 0) FROM '{OUT}/overture-building_part.parquet'",
        # A parent whose parts all fell outside the bbox would vanish; keep it.
        f"SELECT {cols}, 0.0 FROM '{OUT}/overture-building.parquet' b WHERE coalesce(b.has_parts, false) "
        f"AND NOT EXISTS (SELECT 1 FROM '{OUT}/overture-building_part.parquet' p WHERE p.building_id = b.id)",
    ]
    with geojsonl.open("w") as fh:
        for q in queries:
            cur = c.execute(q)
            while rows := cur.fetchmany(100_000):
                for geom, x, y, h, floors, cls, name, src, base in rows:
                    pt = Point(x, y)
                    if any(lm[i].contains(pt) for i in tree.query(pt)):
                        skipped += 1
                        continue
                    height, hs = height_of(h, floors, cls, ghsl.at(x, y))
                    base = base if base and 0 <= base < height else 0
                    props = {"h": height, "b": round(base, 1), "hs": hs, "src": SRC_CODE.get(src, "other")}
                    if cls:
                        props["cls"] = cls
                    if name:
                        props["name"] = name
                    fh.write('{"type":"Feature","geometry":' + geom + ',"properties":' + json.dumps(props, ensure_ascii=False) + "}\n")
                    stats[hs] += 1
                    srcs[props["src"]] = srcs.get(props["src"], 0) + 1
                    n += 1

    print(f"{n} features ({skipped} skipped under curated landmarks)")
    for k, v in stats.items():
        print(f"  height {k:9} {v:8}  {100 * v / n:5.1f}%")
    for k, v in sorted(srcs.items(), key=lambda kv: -kv[1]):
        print(f"  source {k:24} {v:8}")
    (OUT / "hcmc-buildings-v2.stats.json").write_text(json.dumps({"count": n, "height": stats, "source": srcs}, indent=2))

    pm = OUT / "hcmc-buildings-v2.pmtiles"
    subprocess.run([
        "tippecanoe", "-o", str(pm), "--force", "--layer=buildings",
        "--minimum-zoom=12", "--maximum-zoom=15",
        # Every footprint survives at z15; lower zooms thin the densest areas
        # (ids are unique for hover/select, so features can't be coalesced).
        "--drop-densest-as-needed", "--extend-zooms-if-still-dropping",
        "--simplification=4", "--read-parallel", "--generate-ids",
        "--attribution=© OpenStreetMap, Microsoft, Google via Overture Maps; heights GHSL (EC JRC)",
        str(geojsonl),
    ], check=True)
    print(pm, pm.stat().st_size // 1_000_000, "MB")


if __name__ == "__main__":
    {"extract": extract, "bake": bake}[sys.argv[1] if len(sys.argv) > 1 else "bake"]()
