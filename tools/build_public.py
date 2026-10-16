#!/usr/bin/env python3
"""Builds data/public.js, the base map, for one BC electoral district from public BC open data.

    python3 tools/build_public.py SRG                 # writes data/public.js
    python3 tools/build_public.py SRC --out /tmp/src.js

Needs shapely (pip install shapely). Downloads are cached in --cache (default ~/.cache/canvass-maps), so a second run is quick.

Sources, all public:
- Elections BC 2024 boundary set: the electoral district, its voting areas and site-based voting areas (openmaps.gov.bc.ca WFS)
- Elections BC 2024 voting area to voting place assignment (openmaps.gov.bc.ca WFS)
- Elections BC provincial voting results by voting place, and registered voters by voting area (catalogue.data.gov.bc.ca)
- BC Digital Road Atlas, for streets and their labels (openmaps.gov.bc.ca WFS)
- BC Address Geocoder, for address points and voting place locations (geocoder.api.gov.bc.ca)
"""
import argparse, csv, hashlib, json, math, sys, time, urllib.parse, urllib.request
from collections import defaultdict
from pathlib import Path

from shapely.geometry import LineString, MultiLineString, Point, shape
from shapely.ops import linemerge

WFS = 'https://openmaps.gov.bc.ca/geo/pub/wfs'
GEOCODER = 'https://geocoder.api.gov.bc.ca'
RESULTS_CSV = ('https://catalogue.data.gov.bc.ca/dataset/44914a35-de9a-4830-ac48-870001ef8935/resource/'
               '4e7be8e3-0805-4f39-87f3-47c4c29e262d/download/provincial_voting_results_by_voting_place.csv')
REGISTERED_CSV = ('https://catalogue.data.gov.bc.ca/dataset/60bf8c02-1436-49fc-b350-f985618d6881/resource/'
                  'c332d1dc-67aa-4a6a-883f-18a50751844d/download/provincial_registered_voter_counts.csv')
ELECTION = '2024 Provincial General Election'  # results file
REG_EVENT = '2024 General Election'            # registered voters file
DATE = '2024-10-19'
PARTY = {'BC NDP': 'ndp', 'Conservative Party': 'con', 'BC Green Party': 'grn'}  # anyone else is 'oth'
SIMPLIFY = 0.00002   # degrees, about 2 m: boundaries and streets stay on their lines at street zoom
ADDR_PAD = 0.004     # address points: the district's bounding box plus about 300-450 m
ROAD_PAD = (0.0072, 0.0115)  # streets: plus about 800 m (lat, lon), so the map isn't bare at the edge
LABEL_EVERY, LABEL_GAP = 350, 320  # metres between street labels along a street, and between two labels of one name

cache = None


def fetch(url, params=None, tries=4):
    full = url + ('?' + urllib.parse.urlencode(params) if params else '')
    path = cache / hashlib.sha1(full.encode()).hexdigest()
    if path.exists():
        return path.read_bytes()
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(full, headers={'User-Agent': 'canvass-maps build_public.py'}), timeout=120) as r:
                body = r.read()
            path.write_bytes(body)
            return body
        except Exception as e:  # noqa: BLE001 - the open data hosts drop the odd request
            if i == tries - 1:
                raise
            print(f'  retrying {url} ({e})', file=sys.stderr)
            time.sleep(2 * (i + 1))


def wfs(layer, cql=None, bbox=None):
    """Every feature of a WFS layer that matches, a page at a time."""
    out, start = [], 0
    while True:
        params = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeNames': 'pub:' + layer,
                  'outputFormat': 'application/json', 'srsName': 'EPSG:4326', 'sortBy': 'OBJECTID', 'count': 5000, 'startIndex': start}
        if cql:
            params['CQL_FILTER'] = cql
        if bbox:  # (south, west, north, east)
            params['bbox'] = ','.join(map(str, bbox)) + ',urn:ogc:def:crs:EPSG::4326'
        page = json.loads(fetch(WFS, params))['features']
        out += page
        if len(page) < 5000:
            return out
        start += 5000


def csv_rows(url):
    text = fetch(url).decode('utf-8-sig', errors='replace')
    return list(csv.DictReader(text.splitlines()))


def r5(v):
    return round(v, 5)


def rings_of(geom):
    """[lat, lon] rings, simplified: exteriors and holes alike (the maps use even-odd)."""
    geom = geom.simplify(SIMPLIFY, preserve_topology=True)
    polys = [geom] if geom.geom_type == 'Polygon' else list(geom.geoms)
    rings = []
    for p in polys:
        for ring in [p.exterior, *p.interiors]:
            pts = []
            for x, y in ring.coords:
                q = [r5(y), r5(x)]
                if not pts or pts[-1] != q:
                    pts.append(q)
            rings.append(pts)
    return rings


def flat_line(line):
    pts = []
    for x, y in line.simplify(SIMPLIFY).coords:
        q = (r5(y), r5(x))
        if not pts or pts[-1] != q:
            pts.append(q)
    return [v for q in pts for v in q] if len(pts) > 1 else None


def geocode(address):
    d = json.loads(fetch(GEOCODER + '/addresses.json', {'addressString': address, 'maxResults': 1, 'locationDescriptor': 'parcelPoint'}))
    f = d['features'][0] if d.get('features') else None
    if not f or f['properties'].get('score', 0) < 90:
        return None
    x, y = f['geometry']['coordinates']
    return [r5(y), r5(x)]


def sites_within(west, south, east, north):
    """Every address site (no units) in a box. The geocoder only returns a site whose whole parcel is in the box, and at most 500
    per call: so each box is asked for with a margin, and a full one is split in four. Callers dedupe by siteID."""
    m = 0.0015
    d = json.loads(fetch(GEOCODER + '/sites/within.json', {'bbox': f'{west - m:.6f},{south - m:.6f},{east + m:.6f},{north + m:.6f}',
                                                            'maxResults': 500, 'outputSRS': 4326, 'locationDescriptor': 'parcelPoint', 'excludeUnits': 'true'}))
    feats = d.get('features', [])
    if len(feats) < 500:
        return feats
    if east - west < 0.0004:
        print(f'  over 500 address sites near {south:.4f},{west:.4f}: some may be missing', file=sys.stderr)
        return feats
    mx, my = (west + east) / 2, (south + north) / 2
    return [f for b in [(west, south, mx, my), (mx, south, east, my), (west, my, mx, north), (mx, my, east, north)]
            for f in sites_within(*b)]


def street_key(p):
    name, typ, direc = str(p.get('streetName') or '').strip(), (p.get('streetType') or '').strip(), (p.get('streetDirection') or '').strip()
    if not name:
        return None
    parts = [typ, name] if p.get('isStreetTypePrefix') == 'true' else [name, typ]
    parts = ([direc] + parts) if p.get('isStreetDirectionPrefix') == 'true' else (parts + [direc])
    return ' '.join(x for x in parts if x).upper()


def build(code, locality):
    ed = wfs('WHSE_ADMIN_BOUNDARIES.EBC_ELECTORAL_DISTS_BS11_SVW', f"ED_ABBREVIATION='{code}'")
    if len(ed) != 1:
        sys.exit(f'No 2024 electoral district with the code {code}.')
    riding = ed[0]['properties']['ED_NAME']
    outline_geom = shape(ed[0]['geometry'])
    print(f'{riding} ({code})')

    # voting areas
    vas = wfs('WHSE_ADMIN_BOUNDARIES.EBC_VOTING_AREAS_BS11_POLY_SVW', f"ED_ABBREVIATION='{code}'")
    polls = []
    for f in sorted(vas, key=lambda f: int(f['properties']['VA_CODE'])):
        g = shape(f['geometry'])
        at = g.representative_point()
        polls.append({'code': int(f['properties']['VA_CODE']), 'rings': rings_of(g), 'at': [r5(at.y), r5(at.x)]})
    print(f'  {len(polls)} voting areas')

    registered = {r['VA_CODE']: int(r['REGISTERED_VOTERS']) for r in csv_rows(REGISTERED_CSV)
                  if r['ED_ABBREVIATION'] == code and r['EVENT_NAME'] == REG_EVENT}
    print(f'  {sum(registered.values()):,} registered voters in {len(registered)} voting areas')

    # 2024 results by voting place, and the voting place each voting area was assigned for election day
    rows = [r for r in csv_rows(RESULTS_CSV) if r['ED_ABBREVIATION'] == code and r['EVENT_NAME'] == ELECTION]
    blank = lambda: {'ndp': 0, 'con': 0, 'grn': 0, 'oth': 0, 'rej': 0}  # noqa: E731
    by_way, at_place, candidates = {}, defaultdict(dict), {}
    for r in rows:
        k = 'rej' if r['VOTE_CATEGORY'] == 'Rejected' else PARTY.get(r['AFFILIATION'], 'oth')
        n = int(r['VOTES_CONSIDERED'] or 0)
        by_way.setdefault(r['VOTING_OPPORTUNITY'], blank())[k] += n
        if r['VOTING_OPPORTUNITY'] in ('Final voting', 'Advance voting') and r['VOTING_LOCATION']:
            way = 'day' if r['VOTING_OPPORTUNITY'] == 'Final voting' else 'advance'
            place = at_place[(r['VOTING_LOCATION'], r['ADDRESS_STANDARD_ID'])]
            place.setdefault(way, blank())[k] += n
        if r['VOTE_CATEGORY'] == 'Valid' and r['CANDIDATE']:
            last, _, first = r['CANDIDATE'].partition(', ')
            who = {'name': f'{first} {last}'.strip(), 'party': r['AFFILIATION'], 'elected': r['ELECTED'] == 'Y'}
            if who not in candidates.setdefault(k, []):
                candidates[k].append(who)
    assigned = defaultdict(list)
    address_of = {}
    for f in wfs('WHSE_HUMAN_CULTURAL_ECONOMIC.EBC_VAVP_GE2024_SV', f"ED_ABBREVIATION='{code}'"):
        p = f['properties']
        assigned[str(p['ADDRESS_STANDARD_ID'])].append(int(p['VA_CODE']))
        address_of[str(p['ADDRESS_STANDARD_ID'])] = (p['STREET_ADDRESS'], p['LOCALITY'])
    places = []
    for (name, sid), ways in sorted(at_place.items()):
        addr = address_of.get(sid)
        pl = {'name': name, 'address': addr[0] if addr else None, 'polls': sorted(assigned.get(sid, [])),
              'day': ways.get('day'), 'advance': ways.get('advance')}
        if addr and pl['day']:
            at = geocode(f'{addr[0]}, {addr[1]}, BC')
            if at:
                pl['at'] = at
        places.append(pl)
    missing = sorted({p['code'] for p in polls} - {c for pl in places for c in pl['polls']})
    print(f'  {len(places)} voting places; voting areas with no election-day place: {missing or "none"}')

    # streets
    s0, w0, n0, e0 = outline_geom.bounds[1], outline_geom.bounds[0], outline_geom.bounds[3], outline_geom.bounds[2]
    road_box = (s0 - ROAD_PAD[0], w0 - ROAD_PAD[1], n0 + ROAD_PAD[0], e0 + ROAD_PAD[1])
    segs = defaultdict(list)
    for f in wfs('WHSE_BASEMAPPING.DRA_DGTL_ROAD_ATLAS_MPAR_SP', bbox=road_box):
        g = f['geometry']
        if not g:
            continue
        p = f['properties']
        lines = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
        segs[(p['ROAD_NAME_FULL'] or '', (p['ROAD_CLASS'] or 'unclassified').lower())] += [LineString(c) for c in lines if len(c) > 1]
    roads, named = [], defaultdict(list)
    for (name, cls), lines in sorted(segs.items()):
        merged = linemerge(MultiLineString(lines))
        for line in ([merged] if merged.geom_type == 'LineString' else list(merged.geoms)):
            flat = flat_line(line)
            if flat:
                roads.append([cls, flat])
                if name:
                    named[name].append(line)
    names = [''] + sorted(named)
    print(f'  {len(roads):,} street lines, {len(names) - 1} street names')

    # street labels: along each named street every LABEL_EVERY metres, never two of one name within LABEL_GAP
    lat0 = (s0 + n0) / 2
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    in_box = lambda x, y: road_box[0] <= y <= road_box[2] and road_box[1] <= x <= road_box[3]  # noqa: E731
    labels = []
    for name, lines in named.items():
        if name[0].islower():  # 'parking lot', 'private driveway': not a street name
            continue
        idx, placed = names.index(name), []
        metric = sorted((LineString([(x * kx, y * ky) for x, y in line.coords]) for line in lines), key=lambda l: -l.length)
        for m in metric:
            if m.length < 80:
                continue
            spots = [m.length / 2] if m.length < 2 * LABEL_EVERY else [d for d in range(LABEL_EVERY // 2, int(m.length), LABEL_EVERY)]
            for d in spots:
                pt = m.interpolate(d)
                if any(math.hypot(pt.x - q.x, pt.y - q.y) < LABEL_GAP for q in placed):
                    continue
                a, b = m.interpolate(max(0, d - 30)), m.interpolate(min(m.length, d + 30))
                ang = -math.degrees(math.atan2(b.y - a.y, b.x - a.x))
                ang = ang - 180 if ang > 90 else ang + 180 if ang < -90 else ang
                lon, lat = pt.x / kx, pt.y / ky
                if not in_box(lon, lat):
                    continue
                placed.append(pt)
                labels.append([r5(lat), r5(lon), round(ang), idx])
    print(f'  {len(labels):,} street labels')

    # address points, one per house number on each street
    # two grids, the second offset by half a tile, so a big parcel cut by a tile edge in one is whole in the other
    box = (w0 - ADDR_PAD, s0 - ADDR_PAD, e0 + ADDR_PAD, n0 + ADDR_PAD)
    step, sites = 0.01, []
    for off in (0, step / 2):
        x = box[0] - off
        while x < box[2]:
            y = box[1] - off
            while y < box[3]:
                sites += sites_within(max(x, box[0]), max(y, box[1]), min(x + step, box[2]), min(y + step, box[3]))
                y += step
            x += step
    best, seen = {}, set()
    for f in sites:
        p = f['properties']
        if p.get('siteID') in seen:
            continue
        seen.add(p.get('siteID'))
        if (p.get('localityName') or '') != locality or not isinstance(p.get('civicNumber'), int) or p.get('siteStatus') not in (None, 'active'):
            continue
        k = street_key(p)
        if not k:
            continue
        lon, lat = f['geometry']['coordinates']
        rank = (bool(p.get('unitNumber')), bool(p.get('civicNumberSuffix')))  # the building's own site before a unit's
        key = (k, p['civicNumber'])
        if key not in best or rank < best[key][0]:
            best[key] = (rank, [p['civicNumber'], r5(lat), r5(lon)])
    addresses = defaultdict(list)
    for (k, _), (_, row) in sorted(best.items(), key=lambda t: (t[0][0], t[0][1])):
        addresses[k].append(row)
    print(f'  {sum(map(len, addresses.values())):,} address points on {len(addresses)} streets')

    return {
        'riding': riding, 'code': code,
        'sources': {'boundaries': 'Elections BC 2024 boundary set (gazetted 2023-12-07, voting areas 2024-09-19)',
                    'results': 'Elections BC, Provincial Voting Results by voting place, 2024 General Election',
                    'streets': 'BC Digital Road Atlas', 'addresses': 'BC Address Geocoder'},
        'outline': rings_of(outline_geom), 'polls': polls, 'registered': registered,
        'results': {'byWay': by_way, 'places': places, 'candidates': candidates, 'date': DATE},
        'names': names, 'roads': roads, 'streetLabels': labels, 'addresses': dict(sorted(addresses.items())),
    }


def main():
    global cache
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('code', help='Elections BC electoral district code, e.g. SRG for Surrey-Guildford')
    ap.add_argument('--out', default=str(Path(__file__).resolve().parent.parent / 'data' / 'public.js'))
    ap.add_argument('--locality', default='Surrey', help='keep address points in this municipality only (default Surrey)')
    ap.add_argument('--cache', default=str(Path.home() / '.cache' / 'canvass-maps'))
    a = ap.parse_args()
    cache = Path(a.cache)
    cache.mkdir(parents=True, exist_ok=True)
    data = build(a.code.upper(), a.locality)
    js = ('// Generated by tools/build_public.py from public BC open data. Contains no campaign data.\n'
          f'window.PUBLIC_DATA = {json.dumps(data, separators=(",", ":"), ensure_ascii=False)};\n')
    Path(a.out).write_text(js, encoding='utf-8')
    print(f'Wrote {a.out} ({len(js) / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
