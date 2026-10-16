'use strict';
// Route packets for door knockers: a printable map of each route (streets and their names, poll lines, the walk and its
// numbered stops, the plan's voting places) followed by its house sheet (every door in knocking order with boxes to tick).
// One drawing feeds both outputs: a PDF (jsPDF, vendored) and the browser's print view (SVG). Exposed as window.PACKET.
window.PACKET = (() => {
  const { P, polls, esc } = SCC;
  const LAT0 = 49.19, MY = 111132, MX = 111320 * Math.cos(LAT0 * Math.PI / 180);
  const PAGE = { w: 612, h: 792, m: 36 };  // US Letter, in points
  const FRAME = { x: 36, y: 92, w: 540, h: 600 };  // the map on the first page of each route
  const C = { ink: '#1b2129', paper: '#fbfbf8', road: '#c3c7cc', major: '#959ba3', poll: '#8a919b', label: '#4b525c', muted: '#59636f', halo: '#ffffff', plan: '#c99a06' };
  const WIDTH = { freeway: 4, highway: 3.6, arterial: 3.2, collector: 2.3, local: 1.7, strata: 1.2, yield: 1.2 };
  const MAJOR = new Set(['freeway', 'highway', 'arterial']), DASHED = new Set(['trail', 'recreation', 'pedestrian', 'resource']);
  const R = 7.5;  // stop circle radius

  // ------------------------------------------------------------------ the drawing, in points inside the frame
  function model(rt, places, W = FRAME.w, H = FRAME.h) {
    const pts = rt.line.concat(rt.doors.map(d => d.p));
    const lat0 = pts.reduce((t, p) => t + p[0], 0) / pts.length, lon0 = pts.reduce((t, p) => t + p[1], 0) / pts.length;
    const m = ([lat, lon]) => [(lon - lon0) * MX, (lat0 - lat) * MY];
    const ms = pts.map(m), xs = ms.map(p => p[0]), ys = ms.map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = Math.max(70, 0.08 * Math.max(x1 - x0, y1 - y0));
    const k = Math.min(W / (x1 - x0 + 2 * pad), H / (y1 - y0 + 2 * pad));  // points per metre
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const xy = p => { const [x, y] = m(p); return [W / 2 + (x - cx) * k, H / 2 + (y - cy) * k]; };
    const overlaps = line => {
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const [x, y] of line) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, y); d = Math.max(d, y); }
      return b > -20 && a < W + 20 && d > -20 && c < H + 20;
    };
    const inside = ([x, y], e = 0) => x > e && x < W - e && y > e && y < H - e;
    const roads = [];
    for (const [cls, flat] of P.roads) {
      const line = [];
      for (let i = 0; i < flat.length; i += 2) line.push(xy([flat[i], flat[i + 1]]));
      if (overlaps(line)) roads.push({ cls, line });
    }
    roads.sort((a, b) => (WIDTH[a.cls] || 1) - (WIDTH[b.cls] || 1));  // major roads on top
    const rings = [], pollLabels = [];
    for (const p of polls) {
      const rs = p.rings.map(r => r.map(xy)).filter(overlaps);
      if (rs.length) rings.push(...rs);
      const at = xy(p.at);
      if (inside(at, 24)) pollLabels.push({ x: at[0], y: at[1], text: `Poll ${p.code}` });
    }
    // street names: every street on the route gets one, on the street among its doors; the web map's labels fill in the rest
    const fits = l => {  // the whole label inside the frame
      const a = l.ang * Math.PI / 180, hl = l.text.length * 1.8 + 2, ex = Math.abs(Math.cos(a)) * hl + Math.abs(Math.sin(a)) * 4, ey = Math.abs(Math.sin(a)) * hl + Math.abs(Math.cos(a)) * 4;
      return l.x - ex > 3 && l.x + ex < W - 3 && l.y - ey > 3 && l.y + ey < H - 3;
    };
    const upright = deg => (deg > 90 ? deg - 180 : deg <= -90 ? deg + 180 : deg);
    const byStreet = new Map();
    for (const d of rt.doors) if (d.s) { const name = d.civic.replace(/^\d+\s+/, ''); (byStreet.get(name) || byStreet.set(name, []).get(name)).push(xy(d.s.p)); }
    const own = [];
    for (const [text, q] of byStreet) {
      if (q.length < 2) continue;
      let far = [q[0], q[1]], best = -1;
      for (const a of q) for (const b of q) { const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (d > best) { best = d; far = [a, b]; } }
      if (best < text.length * 3.6) continue;  // too short a stretch to carry the name
      const ang = upright(Math.atan2(far[1][1] - far[0][1], far[1][0] - far[0][0]) * 180 / Math.PI);
      own.push({ x: (far[0][0] + far[1][0]) / 2, y: (far[0][1] + far[1][1]) / 2, ang, text });
    }
    const labels = own.concat(P.streetLabels.map(([lat, lon, ang, i]) => { const [x, y] = xy([lat, lon]); return { x, y, ang, text: P.names[i] }; })
      .filter(l => !own.some(o => o.text === l.text && Math.hypot(o.x - l.x, o.y - l.y) < 160))).filter(fits);
    const stops = [];
    rt.doors.forEach((d, i) => {  // neighbouring doors that would overlap share one marker: "12–14"
      const [x, y] = xy(d.p), last = stops.at(-1);
      if (last && Math.hypot(x - last.hx, y - last.hy) < R * 1.4) { last.to = i + 1; return; }
      stops.push({ from: i + 1, to: i + 1, x, y, hx: x, hy: y });
    });
    // markers that still overlap are pushed apart; a thin line ties each moved marker to its door
    for (let pass = 0; pass < 80; pass++) {
      let moved = false;
      for (let i = 0; i < stops.length; i++) for (let j = i + 1; j < stops.length; j++) {
        const a = stops[i], b = stops[j], dx = b.x - a.x, dy = b.y - a.y;
        const ox = (stopWidth(a) + stopWidth(b)) / 2 + 1.5 - Math.abs(dx), oy = 2 * R + 1.5 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy) { const sx = (dx >= 0 ? 1 : -1) * ox / 2; a.x -= sx; b.x += sx; } else { const sy = (dy > 0 || (dy === 0 && j % 2) ? 1 : -1) * oy / 2; a.y -= sy; b.y += sy; }
      }
      for (const st of stops) { st.x = Math.min(W - stopWidth(st) / 2 - 2, Math.max(stopWidth(st) / 2 + 2, st.x)); st.y = Math.min(H - R - 2, Math.max(R + 2, st.y)); }
      if (!moved) break;
    }
    const marks = places.map(pl => { const [x, y] = xy(pl.p); return { x, y, text: pl.name }; }).filter(pl => inside([pl.x, pl.y], 6));
    const want = W * 0.2 / k, nice = [25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000];
    const len = nice.reduce((b, v) => Math.abs(v - want) < Math.abs(b - want) ? v : b, nice[0]);
    return { W, H, roads, rings, pollLabels, labels, route: rt.line.map(xy), stops, marks, scale: { m: len, pt: len * k } };
  }
  const stopText = s => s.from === s.to ? String(s.from) : `${s.from}–${s.to}`;
  const stopWidth = s => Math.max(2 * R, stopText(s).length * 5.1 + 6);

  // ------------------------------------------------------------------ SVG, for the print view
  let svgId = 0;
  function svg(md) {
    const f = n => n.toFixed(1), id = 'rm' + (++svgId);
    const path = pts => 'M' + pts.map(p => `${f(p[0])} ${f(p[1])}`).join('L');
    const out = [`<svg class="route-map" viewBox="0 0 ${md.W} ${md.H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Map of the route">`,
      `<defs><clipPath id="${id}"><rect width="${md.W}" height="${md.H}"/></clipPath></defs><g clip-path="url(#${id})">`,
      `<rect width="${md.W}" height="${md.H}" fill="${C.paper}"/>`];
    for (const r of md.roads) out.push(`<path d="${path(r.line)}" fill="none" stroke="${MAJOR.has(r.cls) ? C.major : C.road}" stroke-width="${WIDTH[r.cls] || 1}" stroke-linecap="round" stroke-linejoin="round"${DASHED.has(r.cls) ? ' stroke-dasharray="2 3"' : ''}/>`);
    for (const ring of md.rings) out.push(`<path d="${path(ring)}Z" fill="none" stroke="${C.poll}" stroke-width="0.9" stroke-dasharray="5 3"/>`);
    out.push(`<path d="${path(md.route)}" fill="none" stroke="${C.halo}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`,
      `<path d="${path(md.route)}" fill="none" stroke="${C.ink}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`);
    const halo = `stroke="${C.halo}" stroke-width="2.4" paint-order="stroke" stroke-linejoin="round"`;
    for (const l of md.labels) out.push(`<text x="${f(l.x)}" y="${f(l.y)}" transform="rotate(${f(l.ang)} ${f(l.x)} ${f(l.y)})" text-anchor="middle" dominant-baseline="central" font-size="6.8" fill="${C.label}" ${halo}>${esc(l.text)}</text>`);
    for (const l of md.pollLabels) out.push(`<text x="${f(l.x)}" y="${f(l.y)}" text-anchor="middle" dominant-baseline="central" font-size="8" font-weight="700" fill="${C.poll}" ${halo}>${esc(l.text)}</text>`);
    for (const p of md.marks) out.push(`<rect x="${f(p.x - 6)}" y="${f(p.y - 6)}" width="12" height="12" rx="2" fill="${C.ink}" stroke="${C.plan}" stroke-width="2.5"/>`,
      `<text x="${f(p.x + 11)}" y="${f(p.y)}" dominant-baseline="central" font-size="8.5" font-weight="700" fill="${C.ink}" ${halo}>${esc(p.text)}</text>`);
    for (const s of md.stops) if (Math.hypot(s.x - s.hx, s.y - s.hy) > 2) out.push(`<path d="M${f(s.hx)} ${f(s.hy)}L${f(s.x)} ${f(s.y)}" stroke="${C.ink}" stroke-width="0.7"/><circle cx="${f(s.hx)}" cy="${f(s.hy)}" r="1.8" fill="${C.ink}"/>`);
    md.stops.forEach((s, i) => {
      const w = stopWidth(s), first = i === 0;
      out.push(`<rect x="${f(s.x - w / 2)}" y="${f(s.y - R)}" width="${f(w)}" height="${2 * R}" rx="${R}" fill="${first ? C.ink : C.halo}" stroke="${C.ink}" stroke-width="1.3"/>`,
        `<text x="${f(s.x)}" y="${f(s.y)}" text-anchor="middle" dominant-baseline="central" font-size="7.2" font-weight="700" fill="${first ? C.halo : C.ink}">${stopText(s)}</text>`);
    });
    out.push('</g>', `<rect width="${md.W}" height="${md.H}" fill="none" stroke="${C.ink}" stroke-width="1"/>`);
    // north arrow and scale bar
    const nx = md.W - 26, ny = 18;
    out.push(`<rect x="${nx - 13}" y="${ny - 8}" width="26" height="36" rx="3" fill="${C.halo}" opacity="0.9"/>`,
      `<path d="M${nx} ${ny - 4}L${nx + 6} ${ny + 12}L${nx} ${ny + 8}L${nx - 6} ${ny + 12}Z" fill="${C.ink}"/>`,
      `<text x="${nx}" y="${ny + 22}" text-anchor="middle" font-size="8" font-weight="700" fill="${C.ink}">N</text>`);
    const sx = 14, sy = md.H - 16;
    out.push(`<rect x="${sx - 6}" y="${sy - 16}" width="${f(md.scale.pt + 40)}" height="26" rx="3" fill="${C.halo}" opacity="0.9"/>`,
      `<path d="M${sx} ${sy - 4}V${sy}H${f(sx + md.scale.pt)}V${sy - 4}" fill="none" stroke="${C.ink}" stroke-width="1.4"/>`,
      `<text x="${sx}" y="${sy - 7}" font-size="7.5" fill="${C.ink}">0</text><text x="${f(sx + md.scale.pt)}" y="${sy - 7}" text-anchor="middle" font-size="7.5" fill="${C.ink}">${md.scale.m} m</text>`);
    return out.join('') + '</svg>';
  }

  // ------------------------------------------------------------------ PDF
  function polyline(doc, pts, ox, oy, close) {
    doc.moveTo(ox + pts[0][0], oy + pts[0][1]);
    for (let i = 1; i < pts.length; i++) doc.lineTo(ox + pts[i][0], oy + pts[i][1]);
    if (close) doc.close();
    doc.stroke();
  }
  function rotatedText(doc, text, cx, cy, deg, size) {  // centred on (cx, cy), turned clockwise by deg like the web map's labels
    const a = deg * Math.PI / 180, w = doc.getTextWidth(text), dx = Math.cos(a), dy = Math.sin(a), lift = size * 0.33;
    const x = cx - dx * w / 2 - dy * lift, y = cy - dy * w / 2 + dx * lift;
    doc.text(text, x, y, { angle: -deg, renderingMode: 'stroke' });
    doc.text(text, x, y, { angle: -deg, renderingMode: 'fill' });
  }
  function haloText(doc, text, x, y, opts = {}) {
    doc.text(text, x, y, { ...opts, renderingMode: 'stroke' });
    doc.text(text, x, y, { ...opts, renderingMode: 'fill' });
  }
  function pdfMap(doc, md, ox, oy) {
    doc.saveGraphicsState();
    doc.rect(ox, oy, md.W, md.H, null);
    doc.clip();
    doc.discardPath();
    doc.setFillColor(C.paper);
    doc.rect(ox, oy, md.W, md.H, 'F');
    doc.setLineCap('round');
    doc.setLineJoin('round');
    for (const r of md.roads) {
      doc.setDrawColor(MAJOR.has(r.cls) ? C.major : C.road);
      doc.setLineWidth(WIDTH[r.cls] || 1);
      doc.setLineDashPattern(DASHED.has(r.cls) ? [2, 3] : [], 0);
      polyline(doc, r.line, ox, oy);
    }
    doc.setDrawColor(C.poll);
    doc.setLineWidth(0.9);
    doc.setLineDashPattern([5, 3], 0);
    for (const ring of md.rings) polyline(doc, ring, ox, oy, true);
    doc.setLineDashPattern([], 0);
    // the walk
    doc.setDrawColor(C.halo);
    doc.setLineWidth(6);
    polyline(doc, md.route, ox, oy);
    doc.setDrawColor(C.ink);
    doc.setLineWidth(2.4);
    polyline(doc, md.route, ox, oy);
    // labels: a white outline under each, so they read over the streets
    doc.setDrawColor(C.halo);
    doc.setLineWidth(2.2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(C.label);
    for (const l of md.labels) rotatedText(doc, l.text, ox + l.x, oy + l.y, l.ang, 6.8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(C.poll);
    for (const l of md.pollLabels) haloText(doc, l.text, ox + l.x, oy + l.y, { align: 'center', baseline: 'middle' });
    for (const p of md.marks) {
      doc.setFillColor(C.ink);
      doc.setDrawColor(C.plan);
      doc.setLineWidth(2.5);
      doc.roundedRect(ox + p.x - 6, oy + p.y - 6, 12, 12, 2, 2, 'FD');
      doc.setDrawColor(C.halo);
      doc.setLineWidth(2.2);
      doc.setFontSize(8.5);
      doc.setTextColor(C.ink);
      haloText(doc, p.text, ox + p.x + 11, oy + p.y, { baseline: 'middle' });
    }
    doc.setDrawColor(C.ink);
    doc.setFillColor(C.ink);
    doc.setLineWidth(0.7);
    for (const s of md.stops) if (Math.hypot(s.x - s.hx, s.y - s.hy) > 2) { doc.line(ox + s.hx, oy + s.hy, ox + s.x, oy + s.y); doc.circle(ox + s.hx, oy + s.hy, 1.8, 'F'); }
    doc.setFontSize(7.2);
    md.stops.forEach((s, i) => {
      const w = stopWidth(s), first = i === 0;
      doc.setFillColor(first ? C.ink : C.halo);
      doc.setDrawColor(C.ink);
      doc.setLineWidth(1.3);
      doc.roundedRect(ox + s.x - w / 2, oy + s.y - R, w, 2 * R, R, R, 'FD');
      doc.setTextColor(first ? C.halo : C.ink);
      doc.text(stopText(s), ox + s.x, oy + s.y, { align: 'center', baseline: 'middle' });
    });
    doc.restoreGraphicsState();
    doc.setDrawColor(C.ink);
    doc.setLineWidth(1);
    doc.rect(ox, oy, md.W, md.H, 'S');
    // north arrow and scale bar
    const nx = ox + md.W - 26, ny = oy + 18;
    doc.setFillColor(C.halo);
    doc.roundedRect(nx - 13, ny - 8, 26, 36, 3, 3, 'F');
    doc.setFillColor(C.ink);
    doc.triangle(nx, ny - 4, nx + 6, ny + 12, nx, ny + 8, 'F');
    doc.triangle(nx, ny - 4, nx - 6, ny + 12, nx, ny + 8, 'F');
    doc.setFontSize(8);
    doc.setTextColor(C.ink);
    doc.text('N', nx, ny + 22, { align: 'center' });
    const sx = ox + 14, sy = oy + md.H - 16;
    doc.setFillColor(C.halo);
    doc.roundedRect(sx - 6, sy - 16, md.scale.pt + 40, 26, 3, 3, 'F');
    doc.setLineWidth(1.4);
    doc.lines([[0, 4], [md.scale.pt, 0], [0, -4]], sx, sy - 4, [1, 1], 'S');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text('0', sx, sy - 7);
    doc.text(`${md.scale.m} m`, sx + md.scale.pt, sy - 7, { align: 'center' });
  }

  // ------------------------------------------------------------------ the pages of one route
  const SHEET = [['#', 20], ['Address', 108], ['Units', 60], ['Who’s there', 136], ['Home', 32], ['Not home', 42], ['Ride', 30], ['Voted', 34], ['Notes', 78]];
  const BOXES = new Set(['Home', 'Not home', 'Ride', 'Voted']);
  function header(doc, title, sub, meta) {
    doc.setTextColor(C.ink);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.text(title, PAGE.m, PAGE.m + 16);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(C.muted);
    doc.text(sub, PAGE.m, PAGE.m + 32, { maxWidth: 360 });
    doc.setTextColor(C.ink);
    doc.text('Canvasser ____________________', PAGE.w - PAGE.m, PAGE.m + 12, { align: 'right' });
    doc.text(`Date ____________   Printed ${meta.printed}`, PAGE.w - PAGE.m, PAGE.m + 28, { align: 'right' });
  }
  function footer(doc, meta) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(C.muted);
    doc.text(`${meta.riding} · confidential campaign list · return it to the office`, PAGE.m, PAGE.h - PAGE.m + 14);
  }
  function routePages(doc, it, meta, places) {
    const { rt, n, of } = it, title = `Route ${it.code || n}`;
    const sub = `${it.area || meta.area} · route ${n} of ${of} · ${rt.doors.length} doors · ${meta.km(rt.len)} · about ${meta.hm(rt.minutes)}`;
    // page 1: the map
    header(doc, title, sub, meta);
    pdfMap(doc, model(rt, places), FRAME.x, FRAME.y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(C.ink);
    doc.text(`Start at the black circle (1) and follow the line. Numbers are the stops on the house sheet; "12–14" marks doors next to each other.
Dashed grey lines are poll boundaries${places.length ? '; the gold-edged squares are the plan’s voting places' : ''}.`, PAGE.m, FRAME.y + FRAME.h + 16, { maxWidth: PAGE.w - 2 * PAGE.m });
    footer(doc, meta);
    // then the house sheet
    let page = 1, y = 0;
    const startSheet = () => {
      doc.addPage();
      header(doc, `${title} · house sheet${page > 1 ? ` (continued)` : ''}`, sub, meta);
      y = 84;
      doc.setFillColor('#eeeeee');
      doc.rect(PAGE.m, y, PAGE.w - 2 * PAGE.m, 18, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(C.ink);
      let x = PAGE.m;
      for (const [name, w] of SHEET) { if (BOXES.has(name)) doc.text(name, x + w / 2, y + 12, { align: 'center' }); else doc.text(name, x + 4, y + 12); x += w; }
      y += 18;
      footer(doc, meta);
      page++;
    };
    startSheet();
    doc.setLineWidth(0.6);
    rt.doors.forEach((d, i) => {
      doc.setFontSize(9);
      const cells = [String(i + 1), d.civic, meta.units(d), meta.who(d)].map((t, c) => doc.splitTextToSize(t, SHEET[c][1] - 8));
      const h = Math.max(24, Math.max(...cells.map(c => c.length)) * 11 + 9);
      if (y + h > PAGE.h - PAGE.m - 8) startSheet();
      doc.setDrawColor('#888888');
      let x = PAGE.m;
      SHEET.forEach(([name, w], c) => {
        doc.rect(x, y, w, h, 'S');
        if (c < 4) {
          doc.setFont('helvetica', c === 1 ? 'bold' : 'normal');
          doc.setTextColor(C.ink);
          doc.text(cells[c], x + 4, y + 14);
        } else if (BOXES.has(name)) {
          doc.rect(x + w / 2 - 5, y + h / 2 - 5, 10, 10, 'S');
        }
        x += w;
      });
      y += h;
    });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(C.ink);
    if (y + 30 > PAGE.h - PAGE.m - 8) startSheet();
    doc.text('Doors knocked ______    Home ______    Rides needed ______    Back to the office at ______', PAGE.m, y + 24);
  }
  function pdf(items, meta, places) {
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
    doc.setProperties({ title: `${meta.area} – door-knocking routes`, subject: 'Confidential campaign list' });
    items.forEach((it, i) => { if (i) doc.addPage(); routePages(doc, it, meta, places); });
    return doc.output('blob');
  }
  return { model, svg, pdf };
})();
