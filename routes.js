'use strict';
// Door-knocking routes on the street network (BC Digital Road Atlas, without freeways and ramps). The doors are first split
// into compact blocks: halved across their longer side, at the widest gap near the middle, until each block holds about the
// requested number of doors and its walk stays under the requested length. Inside a block, doors are grouped into street
// runs (one street, in house-number order; long streets go up one side and back down the other), runs are chained by
// walking distance from the nearest unvisited run, and the chain is shortened with 2-opt. Paths between doors follow the
// streets. Exposed as window.WALK.
window.WALK = (() => {
  const { P } = SCC;
  const LAT0 = 49.19, MY = 111132, MX = 111320 * Math.cos(LAT0 * Math.PI / 180);  // metres per degree here
  const metres = (a, b) => Math.hypot((a[0] - b[0]) * MY, (a[1] - b[1]) * MX);
  const WALK_M_PER_MIN = 75;  // 4.5 km/h
  const DOOR_MIN = 2, EXTRA_UNIT_MIN = 1;  // a knock and a short talk; each extra unit in a building adds a minute

  // ------------------------------------------------------------------ graph
  const nodes = [], ids = new Map(), adj = [], edges = [];
  const node = (lat, lon) => {
    const k = lat.toFixed(5) + ',' + lon.toFixed(5);
    let i = ids.get(k);
    if (i == null) { i = nodes.length; ids.set(k, i); nodes.push([lat, lon]); adj.push([]); }
    return i;
  };
  for (const [cls, flat] of P.roads) {
    if (cls === 'freeway' || cls === 'ramp') continue;
    for (let i = 0; i + 3 < flat.length; i += 2) {
      const a = node(flat[i], flat[i + 1]), b = node(flat[i + 2], flat[i + 3]);
      if (a === b) continue;
      const len = metres(nodes[a], nodes[b]), e = edges.length;
      edges.push([a, b, len]);
      adj[a].push([b, len, e]);
      adj[b].push([a, len, e]);
    }
  }
  // The road atlas leaves out the walkways that join the ends of many Surrey streets (and a few junctions miss by a few
  // metres): link street ends that are close to each other, at a 20% walking penalty
  {
    const dead = nodes.map((_, i) => i).filter(i => adj[i].length === 1);
    const link = (a, b, limit) => {
      const len = metres(nodes[a], nodes[b]);
      if (len > limit || adj[a].some(([m]) => m === b)) return;
      const e = edges.length;
      edges.push([a, b, len * 1.2]);
      adj[a].push([b, len * 1.2, e]);
      adj[b].push([a, len * 1.2, e]);
    };
    for (let x = 0; x < dead.length; x++) for (let y = x + 1; y < dead.length; y++) link(dead[x], dead[y], 100);
    for (const a of dead) {  // a street end a few metres short of another street
      let best = -1, bd = 15;
      for (let i = 0; i < nodes.length; i++) { if (i === a || adj[a].some(([m]) => m === i)) continue; const d = metres(nodes[a], nodes[i]); if (d < bd) { bd = d; best = i; } }
      if (best >= 0) link(a, best, 15);
    }
  }
  // grid of edges for snapping a door to its street
  const CELL = 0.002, grid = new Map();
  const cellKey = (y, x) => `${Math.floor(y / CELL)},${Math.floor(x / CELL)}`;
  edges.forEach(([a, b], e) => {
    const [y1, x1] = nodes[a], [y2, x2] = nodes[b];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(y2 - y1), Math.abs(x2 - x1)) / (CELL / 2)));
    const seen = new Set();
    for (let s = 0; s <= steps; s++) {
      const k = cellKey(y1 + (y2 - y1) * s / steps, x1 + (x2 - x1) * s / steps);
      if (seen.has(k)) continue;
      seen.add(k);
      (grid.get(k) || grid.set(k, []).get(k)).push(e);
    }
  });
  // nearest point on a street: {e, t (0..1 along the edge), p, off (metres from the door)}
  function snap(p) {
    const cy = Math.floor(p[0] / CELL), cx = Math.floor(p[1] / CELL);
    let best = null;
    for (let r = 1; r <= 6 && !best; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        for (const e of grid.get(`${cy + dy},${cx + dx}`) || []) {
          const [a, b] = edges[e], A = nodes[a], B = nodes[b];
          const ax = (B[1] - A[1]) * MX, ay = (B[0] - A[0]) * MY, px = (p[1] - A[1]) * MX, py = (p[0] - A[0]) * MY;
          const t = Math.max(0, Math.min(1, (px * ax + py * ay) / ((ax * ax + ay * ay) || 1)));
          const q = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t], off = metres(p, q);
          if (!best || off < best.off) best = { e, t, p: q, off };
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ shortest walks
  class Heap {  // binary min-heap of [cost, node]
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; } }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; }
      }
      return top;
    }
  }
  const ends = s => { if (s.e < 0) return []; const [a, b, len] = edges[s.e]; return [[a, s.t * len], [b, (1 - s.t) * len]]; };
  // walking distances from a snapped point to every node within `limit` metres
  function reach(from, limit) {
    const dist = new Map(), heap = new Heap();
    for (const [n, d] of ends(from)) if (d < (dist.get(n) ?? Infinity)) { dist.set(n, d); heap.push([d, n]); }
    while (heap.size) {
      const [d, n] = heap.pop();
      if (d > dist.get(n) || d > limit) continue;
      for (const [m, len] of adj[n]) { const nd = d + len; if (nd < (dist.get(m) ?? Infinity)) { dist.set(m, nd); heap.push([nd, m]); } }
    }
    return dist;
  }
  const sameEdge = (a, b) => a.e === b.e && a.e >= 0 ? Math.abs(a.t - b.t) * edges[a.e][2] : Infinity;
  function distTo(dist, s) {  // distance from a reach() result to a snapped point
    let best = Infinity;
    for (const [n, d] of ends(s)) { const x = dist.get(n); if (x != null && x + d < best) best = x + d; }
    return best;
  }
  // A* between two snapped points: {len, line} along the streets, or a straight hop when they aren't connected
  function path(sa, sb) {
    const direct = sameEdge(sa, sb);
    if (direct < Infinity) return { len: direct, line: [sa.p, sb.p] };
    const goal = new Map(ends(sb)), g = new Map(), prev = new Map(), heap = new Heap(), done = new Set();
    const h = n => metres(nodes[n], sb.p);
    for (const [n, d] of ends(sa)) if (d < (g.get(n) ?? Infinity)) { g.set(n, d); prev.set(n, -1); heap.push([d + h(n), n]); }
    let best = Infinity, bestNode = -1;
    while (heap.size) {
      const [f, n] = heap.pop();
      if (done.has(n)) continue;
      done.add(n);
      if (f >= best) break;
      if (goal.has(n) && g.get(n) + goal.get(n) < best) { best = g.get(n) + goal.get(n); bestNode = n; }
      for (const [m, len] of adj[n]) {
        const nd = g.get(n) + len;
        if (nd < (g.get(m) ?? Infinity)) { g.set(m, nd); prev.set(m, n); heap.push([nd + h(m), m]); }
      }
    }
    if (bestNode < 0) return { len: metres(sa.p, sb.p) * 1.3, line: [sa.p, sb.p], hop: true };
    const line = [sb.p];
    for (let n = bestNode; n !== -1; n = prev.get(n)) line.push(nodes[n]);
    line.push(sa.p);
    return { len: best, line: line.reverse() };
  }

  // ------------------------------------------------------------------ ordering doors into routes
  // doors: [{ p, street, num, units, ... }]; returns runs in walking order
  function runsOf(doors) {
    const byStreet = new Map();
    for (const d of doors) (byStreet.get(d.street) || byStreet.set(d.street, []).get(d.street)).push(d);
    const runs = [];
    for (const list of byStreet.values()) {
      list.sort((a, b) => a.num - b.num);
      let cur = [list[0]];
      for (let i = 1; i < list.length; i++) {
        if (metres(list[i - 1].p, list[i].p) > 150) { runs.push(cur); cur = []; }  // a gap: another block of the same street
        cur.push(list[i]);
      }
      runs.push(cur);
    }
    return runs.map(r => {
      // a long run with both sides: up the odd side, back down the even side, so nobody criss-crosses a busy street
      const span = metres(r[0].p, r.at(-1).p), odd = r.filter(d => d.num % 2), even = r.filter(d => !(d.num % 2));
      const seq = span >= 250 && odd.length && even.length ? [...odd, ...even.reverse()] : r;
      return { seq, first: seq[0], last: seq.at(-1) };
    });
  }
  function chain(runs, startAt) {
    const left = new Set(runs.keys()), out = [];
    let here = startAt;
    while (left.size) {
      const dist = here ? reach(here, 2500) : null;
      let best = null;
      for (const i of left) {
        const r = runs[i];
        for (const [entry, rev] of [[r.first, false], [r.last, true]]) {
          let d = dist ? distTo(dist, entry.s) : 0;
          if (here && d === Infinity) d = metres(here.p, entry.s.p) * 1.4 + 2500;  // not reachable on foot nearby
          if (!best || d < best.d) best = { i, rev, d };
        }
      }
      const r = runs[best.i], seq = best.rev ? [...r.seq].reverse() : r.seq;
      out.push(seq);
      left.delete(best.i);
      here = seq.at(-1).s;
    }
    return out;
  }
  // walking distances between every pair of doors (up to 1.5 km; farther pairs fall back to a straight-line guess)
  function walkMatrix(doors) {
    const n = doors.length, D = new Float32Array(n * n);
    doors.forEach((d, i) => { d.ix = i; });
    for (let i = 0; i < n; i++) {
      const reachI = reach(doors[i].s, 1500);
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        let v = sameEdge(doors[i].s, doors[j].s);
        if (v === Infinity) v = distTo(reachI, doors[j].s);
        D[i * n + j] = v === Infinity ? metres(doors[i].p, doors[j].p) * 1.5 + 1500 : v;
      }
    }
    return (a, b) => D[a.ix * n + b.ix];
  }
  // 2-opt on the door order (the first and last doors stay put); walking distances when given, else straight lines
  function improve(seq, dist) {
    // a fixed number of passes, never a time limit: every computer must cut the same routes, so packet codes match the desk
    const n = seq.length, d = dist || ((a, b) => metres(a.p, b.p));
    for (let pass = 0, better = true; better && pass < 40; pass++) {
      better = false;
      for (let i = 0; i < n - 3; i++) {
        for (let k = i + 2; k < n - 1; k++) {
          if (d(seq[i], seq[k]) + d(seq[i + 1], seq[k + 1]) < d(seq[i], seq[i + 1]) + d(seq[k], seq[k + 1]) - 1) {
            for (let a = i + 1, b = k; a < b; a++, b--) [seq[a], seq[b]] = [seq[b], seq[a]];
            better = true;
          }
        }
      }
    }
    return seq;
  }
  const doorMinutes = d => DOOR_MIN + EXTRA_UNIT_MIN * Math.max(0, (d.unitCount || 1) - 1);
  function trace(doors) {  // the walk through doors in order
    let len = 0;
    const line = [];
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      if (i) {
        const step = path(doors[i - 1].s, d.s);
        len += step.len;
        line.push(...step.line);
      }
      line.push(d.s.p);
    }
    const minutes = len / WALK_M_PER_MIN + doors.reduce((t, d) => t + doorMinutes(d), 0);
    return { len, line, minutes };
  }
  // compact blocks of doors: split across the longer side until each block has about `size` doors and its walk along the
  // streets is no longer than maxLen (small blocks are never split for length). Returns walked blocks.
  const MIN_SPLIT = 12;  // a block this small is never split for length: its halves would be too small to be worth a trip
  function blocks(doors, size, maxLen) {
    const out = [];
    const split = set => {
      const n = set.length, parts = Math.max(1, Math.ceil(n / (size * 1.15)));
      if (parts === 1) {
        const ds = walkBlock(set, nw(set)), tr = trace(ds);
        if (!maxLen || n < MIN_SPLIT || tr.len <= maxLen) { out.push({ ds, tr }); return; }
      }
      const halves = Math.max(2, parts), target = Math.round(n * Math.floor(halves / 2) / halves);
      const ys = set.map(d => d.p[0] * MY), xs = set.map(d => d.p[1] * MX);
      const wide = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
      const at = d => wide ? d.p[1] : d.p[0];
      const sorted = [...set].sort((a, b) => at(a) - at(b) || a.num - b.num);
      const win = Math.max(1, Math.round(n * 0.12));
      let cutAt = target, gap = -1;
      for (let i = Math.max(1, target - win); i <= Math.min(n - 1, target + win); i++) {
        const g = Math.abs(at(sorted[i]) - at(sorted[i - 1]));
        if (g > gap) { gap = g; cutAt = i; }
      }
      split(sorted.slice(0, cutAt));
      split(sorted.slice(cutAt));
    };
    split(doors);
    return out;
  }
  const nw = ds => [Math.max(...ds.map(d => d.p[0])), Math.min(...ds.map(d => d.p[1]))];
  function walkBlock(ds, corner) {  // one route through a block
    const runs = runsOf(ds);
    const first = runs.reduce((b, r) => { const d = Math.min(metres(corner, r.first.p), metres(corner, r.last.p)); return !b || d < b.d ? { r, d } : b; }, null).r;
    return improve(chainFrom(runs, first, corner).flat(), walkMatrix(ds));
  }
  // the whole plan: doors in, routes out ({ doors, len, minutes, line }). Blocks are numbered in a sweep from the north-west.
  function plan(doors, size, opts = {}) {
    const placed = doors.filter(d => d.p);
    if (!placed.length) return [];
    placed.forEach(d => { d.s = d.s || snap(d.p) || { e: -1, t: 0, p: d.p, off: 0 }; });
    const centre = ds => [ds.reduce((t, d) => t + d.p[0], 0) / ds.length, ds.reduce((t, d) => t + d.p[1], 0) / ds.length];
    const left = blocks(placed, size, opts.maxLen).map(b => ({ ...b, c: centre(b.ds) }));
    let here = nw(placed);
    const routes = [];
    while (left.length) {
      let bi = 0;
      left.forEach((b, i) => { if (metres(here, b.c) < metres(here, left[bi].c)) bi = i; });
      const [b] = left.splice(bi, 1);
      // walk the block from whichever end is nearer the last route
      const flip = metres(here, b.ds.at(-1).p) < metres(here, b.ds[0].p), ds = flip ? [...b.ds].reverse() : b.ds;
      routes.push({ doors: ds, ...(flip ? trace(ds) : b.tr) });
      here = ds.at(-1).p;
    }
    return routes;
  }
  function chainFrom(runs, first, corner) {  // start with the run nearest the corner, entered from its nearer end
    const rev = metres(corner, first.last.p) < metres(corner, first.first.p);
    const seq = rev ? [...first.seq].reverse() : first.seq;
    return [seq, ...chain(runs.filter(r => r !== first), seq.at(-1).s)];
  }
  // a quick estimate without the street paths, for ranking many polls at once
  function estimate(doors) {
    const placed = doors.filter(d => d.p);
    if (!placed.length) return { len: 0, minutes: 0 };
    const runs = runsOf(placed);
    let len = 0, here = null;
    const left = new Set(runs);
    for (const r of runs) for (let i = 1; i < r.seq.length; i++) len += metres(r.seq[i - 1].p, r.seq[i].p);
    while (left.size) {
      let best = null;
      for (const r of left) for (const e of [r.first, r.last]) { const d = here ? metres(here, e.p) : 0; if (!best || d < best.d) best = { r, e, d }; }
      len += best.d * 1.3;
      left.delete(best.r);
      here = (best.e === best.r.first ? best.r.last : best.r.first).p;
    }
    return { len, minutes: len / WALK_M_PER_MIN + placed.reduce((t, d) => t + doorMinutes(d), 0) };
  }
  return { plan, estimate, trace, snap, metres, WALK_M_PER_MIN, DOOR_MIN, EXTRA_UNIT_MIN };
})();
