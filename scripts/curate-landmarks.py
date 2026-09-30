#!/usr/bin/env python3
"""
curate-landmarks.py — real OSM footprints for the HCMC hero landmarks.

Replaces the hand-drawn 4-corner rectangles in public/hcmc-landmarks.geojson
with the actual OSM building outline (and its building:part stack when OSM
has one). Heights stay the published figure; each feature cites its source.
A landmark OSM can't find is reported and left out — never a rectangle.

Usage: python3 scripts/curate-landmarks.py        (rewrites the geojson)
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from shapely.geometry import Point, Polygon, shape, mapping

OUT = Path(__file__).resolve().parent.parent / "public" / "hcmc-landmarks.geojson"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
CBD = "(10.74,106.66,10.82,106.75)"  # name search box: D1, D3, Binh Thanh, Thu Thiem
UA = "hcmc-3d-atlas/0.2 (https://atlas.hcmc.nonarkara.org; landmark curation)"

# name, OSM name regex, anchor (lat, lon), height m, category, height source
LANDMARKS = [
    ("Landmark 81", "Landmark 81", (10.7950, 106.7218), 461.2, "tower", "CTBUH Skyscraper Center"),
    ("Bitexco Financial Tower", "Bitexco", (10.7717, 106.7044), 262.5, "tower", "CTBUH Skyscraper Center"),
    ("Vietcombank Tower", "Vietcombank", (10.7771, 106.7055), 206.0, "tower", "CTBUH Skyscraper Center"),
    ("Saigon Centre Tower 2", "Saigon Centre|Takashimaya", (10.7730, 106.7010), 193.0, "tower", "CTBUH Skyscraper Center"),
    # Saigon Centre Tower 1 left out: OSM maps the complex as one podium
    # (way/802125677) plus Tower 2; no way is identifiably Tower 1.
    ("Vincom Landmark Plus", "Landmark Plus", (10.7943, 106.7208), 152.0, "tower", "developer published"),
    ("Sunwah Pearl", "Sunwah Pearl", (10.7973, 106.7270), 175.0, "tower", "developer published"),
    ("Saigon Trade Center", "Saigon Trade Center|Saigon Trade Centre", (10.7825, 106.7040), 145.0, "tower", "CTBUH Skyscraper Center"),
    ("Times Square", "Times Square", (10.7760, 106.7040), 164.0, "tower", "CTBUH Skyscraper Center"),
    ("The 81 Premier", "Park 1|The 81", (10.7948, 106.7226), 220.0, "tower", "developer published"),
    ("Vinhomes Golden River", "Golden River|Aqua", (10.7835, 106.7075), 180.0, "tower", "developer published"),
    ("IFC One Saigon", "IFC One|One Saigon", (10.7765, 106.7065), 195.0, "tower", "developer published"),
    ("Notre-Dame Cathedral Basilica of Saigon", "Nhà thờ Đức Bà|Notre", (10.7798, 106.6990), 57.0, "civic", "spire height, Archdiocese of Saigon"),
    ("Saigon Central Post Office", "Bưu điện|Post Office", (10.7799, 106.7000), 32.0, "civic", "curated estimate"),
    ("Independence Palace", "Dinh Độc Lập|Independence Palace|Reunification", (10.7770, 106.6953), 26.0, "civic", "curated estimate"),
    ("Ho Chi Minh City Hall", "Ủy ban|City Hall|UBND Thành phố", (10.7765, 106.7010), 32.0, "civic", "curated estimate"),
    ("Ben Thanh Market", "Chợ Bến Thành|Ben Thanh", (10.7725, 106.6980), 18.0, "civic", "clock tower, curated estimate"),
    ("Ho Chi Minh City Museum", "Bảo tàng Thành phố|City Museum|Gia Long", (10.7762, 106.6998), 22.0, "civic", "curated estimate"),
    ("Saigon Opera House", "Nhà hát Thành phố|Opera House|Municipal Theatre", (10.7766, 106.7031), 25.0, "civic", "curated estimate"),
]


def overpass(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    for url in OVERPASS:
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)["elements"]
        except Exception as e:  # try the next mirror
            print("   overpass", url.split("/")[2], "failed:", e)
            time.sleep(2)
    return []


def ring(el):
    """Outer ring of a way, or the first outer member of a relation."""
    if el["type"] == "way" and "geometry" in el:
        pts = [(g["lon"], g["lat"]) for g in el["geometry"]]
    elif el["type"] == "relation":
        outers = [m for m in el.get("members", []) if m.get("role") == "outer" and "geometry" in m]
        if not outers:
            return None
        pts = [(g["lon"], g["lat"]) for g in outers[0]["geometry"]]
    else:
        return None
    if len(pts) < 4:
        return None
    poly = Polygon(pts)
    return poly if poly.is_valid and poly.area > 0 else poly.buffer(0)


def num(v):
    try:
        return float(str(v).lower().replace("m", "").strip())
    except (TypeError, ValueError):
        return None


# Name search is ambiguous inside one complex; pin the exact OSM way.
PINNED = {"Saigon Centre Tower 2": 802125674}


def curate(name, pattern, anchor, height, category, source):
    lat, lon = anchor
    if name in PINNED:
        els = overpass(f"[out:json][timeout:60];way({PINNED[name]});out geom tags;")
        if not els:
            return None, f"pinned way/{PINNED[name]} not returned"
        poly = ring(els[0])
        return [feature(poly, name, category, height, 0, source, f"way/{PINNED[name]}")], f"pinned way/{PINNED[name]}"
    q = (
        "[out:json][timeout:60];("
        f'nwr{CBD}["building"]["name"~"{pattern}",i];'
        f'nwr{CBD}["building"]["name:en"~"{pattern}",i];'
        f"way(around:120,{lat},{lon})[\"building\"];"
        f"way(around:350,{lat},{lon})[\"building:part\"];"
        f"relation(around:120,{lat},{lon})[\"building\"];"
        ");out geom tags;"
    )
    els = overpass(q)
    buildings, parts = [], []
    for el in els:
        poly = ring(el)
        if poly is None:
            continue
        tags = el.get("tags", {})
        rec = (el, poly, tags)
        (parts if "building:part" in tags and "building" not in tags else buildings).append(rec)

    import re
    rx = re.compile(pattern, re.I)
    named = [b for b in buildings if rx.search(b[2].get("name", "") + " " + b[2].get("name:en", ""))]
    pool = named or buildings
    if not pool:
        return None, "no OSM building near anchor"
    here = Point(lon, lat)
    # Prefer a named match; among candidates the one containing / nearest the anchor.
    el, poly, tags = min(pool, key=lambda b: (0 if b[1].contains(here) else 1, b[1].distance(here)))
    if not named and not poly.contains(here) and poly.distance(here) > 0.0004:
        return None, "nearest OSM building is >40 m from anchor and unnamed"

    osm = f"{el['type']}/{el['id']}"
    inside = [p for p in parts if poly.buffer(0.00002).contains(p[1].representative_point())]
    feats = []
    tall_parts = [p for p in inside if num(p[2].get("height"))]
    if tall_parts:
        top = max(num(p[2]["height"]) for p in tall_parts)
        scale = height / top if top else 1  # keep the published total height
        for pel, ppoly, ptags in tall_parts:
            h = num(ptags["height"]) * scale
            base = (num(ptags.get("min_height")) or 0) * scale
            feats.append(feature(ppoly, name, category, round(h, 1), round(base, 1), source,
                                 f"{pel['type']}/{pel['id']}", part=True))
        # Label anchor: the outline itself as a flat (0 m) feature is not needed;
        # mark the tallest part as the labelled one.
        max(feats, key=lambda f: f["properties"]["height"])["properties"].pop("part")
    else:
        feats.append(feature(poly, name, category, height, 0, source, osm))
    return feats, f"{osm} ({len(poly.exterior.coords)} vertices, {len(feats)} part(s), named={bool(named)})"


def feature(poly, name, category, height, base, source, osm, part=False):
    props = {"name": name, "category": category, "height": height, "base_height": base,
             "source": source, "osm": osm}
    if part:
        props["part"] = True
    g = mapping(poly.simplify(0.000003, preserve_topology=True))
    return {"type": "Feature", "geometry": g, "properties": props}


def main():
    # `curate-landmarks.py "Name" ...` re-curates only those, keeping the rest.
    only = set(sys.argv[1:])
    feats, missing = [], []
    if only and OUT.exists():
        old = json.loads(OUT.read_text())
        feats = [f for f in old["features"] if f["properties"]["name"] not in only]
    for spec in LANDMARKS:
        if only and spec[0] not in only:
            continue
        print(spec[0])
        got, note = curate(*spec)
        print("  ", note)
        if got:
            feats.extend(got)
        else:
            missing.append({"name": spec[0], "reason": note})
        time.sleep(1.5)
    doc = {
        "type": "FeatureCollection",
        "name": "hcmc-landmarks",
        "description": "HCMC hero landmarks. Footprints: OpenStreetMap (ODbL). Heights: published figures, cited per feature. Built by scripts/curate-landmarks.py.",
        "features": feats,
        "missing": missing,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1))
    print(f"{len(feats)} features, {len(missing)} missing → {OUT}")


if __name__ == "__main__":
    main()
