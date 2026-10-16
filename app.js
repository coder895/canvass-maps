'use strict';
// Campaign map. Public map data comes from data/public.js; the Poll Summary and Interactions exports are read
// in this tab with SheetJS and never leave it (the page's CSP blocks every outbound connection).
(() => {
  const { P, $, fmt, pct, esc, day, reduced, phone, vaName, tok, lean, leanText, chip, RESULT_STEPS, RESULT_LABELS, classOf, sumWays, total, places, runs, polls, pollByKey, partyBars,
    siteKey, prettyCivic, locate, inside, listAddress, sniff, pollKey, parsePollSummary, parseInteractions, parseList, listKind, NO_POLL, listFromRows, readWorkbook,
    stamp, parseCast, mergeCast, voterNosFromRows, parseVoterNos, castPeople, castSave, castSaved, voteTab, ENC, gate, baseMap, placer, sheet } = SCC;
  const app = $('app');

  // ------------------------------------------------------------------ state
  const S = { ps: null, ix: null, turnout: null, cast: null, voterNos: null, castBy: null, sites: [], view: 'support', shade: 'result', sel: null, sort: null };
  const voted = voteTab($('pane-voted'), () => ({ vn: S.voterNos, cast: S.cast, polls: pollRows().map(r => ({ key: r.key, label: r.label, reg: r.reg })) }),
    x => showHouse(S.sites.find(s => s.key === x.home.key)), key => goPoll(key));

  // ------------------------------------------------------------------ map
  const { map, streetLabels, placeMarkers, styleBase, onTheme } = baseMap('map', [['roads', 300, true], ['mask', 340, true], ['data', 400],
    ['pollLabels', 420, true], ['streetLabels', 430, true], ['places', 440, true], ['houseLabels', 460, true]]);
  const dataCanvas = L.canvas({ pane: 'data', padding: 0.4, tolerance: 3 });

  // polls: one canvas with the households so a click hits the household on top first
  polls.forEach(p => {
    p.layer = L.polygon(p.rings, { renderer: dataCanvas, pane: 'data', weight: 1, fillOpacity: 0 }).addTo(map)
      .bindTooltip(() => pollTip(p), { sticky: true, direction: 'top', offset: [0, -10], opacity: 1 })
      .on('mouseover', () => p.layer.setStyle({ weight: 2.5, color: tok('fg') }))
      .on('mouseout', () => stylePoll(p))
      .on('click', e => openPoll(p, e.latlng));
  });

  // ------------------------------------------------------------------ poll shading
  const SHADES = [
    { k: 'result', label: '2024 result' },
    { k: 'support', label: 'Supporters found', needs: 'ps' },
    { k: 'unknown', label: 'No answer yet', needs: 'ps' },
    { k: 'skipped', label: 'Didn’t vote in 2024', needs: 'lists' },
    { k: 'cast', label: 'Voted so far', needs: 'cast' },
  ];
  const ALPHA5 = [0.08, 0.2, 0.34, 0.5, 0.66];
  const STEPS = {
    support: { color: 'con', breaks: [0.02, 0.05, 0.10, 0.20, 0.35], alpha: [0.06, 0.16, 0.28, 0.42, 0.56, 0.70], get: r => r.supportPct, label: v => pct(v),
      title: 'Supporters found, as a share of people on file', note: 'From the Poll Summary.' },
    unknown: { color: 'ramp-contact', breaks: [0.5, 0.7, 0.85, 0.95], alpha: ALPHA5, get: r => r.unknown, label: v => pct(v), quantile: 0.01,
      title: 'People with no support answer yet', note: 'From the Poll Summary’s “unknown” share. Darker means more people still to reach.' },
    skipped: { color: 'ramp-gotv', breaks: [10, 25, 50, 100], alpha: ALPHA5, get: r => r.not, label: v => fmt(v), quantile: 5, src: 'turnout',
      title: 'Supporters who didn’t vote in 2024', note: 'From the 2024 supporter lists. Darker means more people to remind to vote.' },
    cast: { color: 'cast', breaks: [0.02, 0.05, 0.1, 0.2, 0.3], alpha: [0.06, 0.16, 0.28, 0.42, 0.56, 0.70], get: r => r.share, label: v => pct(v), src: 'cast',
      title: 'Voted so far, as a share of registered voters', note: 'From the Elections BC participation report, by the voting area it gives each voter.' },
  };
  const has = needs => !needs || (needs === 'ps' ? !!S.ps : needs === 'lists' ? !!S.turnout : needs === 'cast' ? !!S.cast : true);
  const rowFor = (st, key) => st.src === 'turnout' ? turnoutFor(key) : st.src === 'cast' ? castFor(key) : S.ps && S.ps.rows.get(key);
  function setBreaks() {  // quintiles of the loaded polls, rounded, so each shade holds about a fifth of the map
    for (const st of Object.values(STEPS)) {
      if (!st.quantile) continue;
      const vals = polls.map(p => rowFor(st, p.key)).filter(Boolean).map(st.get).sort((a, b) => a - b);
      if (vals.length < 5) continue;
      const q = [0.2, 0.4, 0.6, 0.8].map(f => Math.round(vals[Math.floor(f * (vals.length - 1))] / st.quantile) * st.quantile);
      st.breaks = q.filter((v, i) => i === 0 || v > q[i - 1]);
      st.alpha = ALPHA5.slice(5 - st.breaks.length - 1);
    }
  }
  function shadeOf(p) {
    if (S.shade === 'result') {
      if (!p.place) return null;
      const l = lean(p.place.day);
      const [, , color, alpha] = RESULT_STEPS.find(([a, b]) => l >= a && l < b);
      return { color, alpha };
    }
    const st = STEPS[S.shade], r = st && rowFor(st, p.key);
    return r ? { color: st.color, alpha: st.alpha[classOf(st.get(r), st.breaks)] } : null;
  }
  function stylePoll(p) {
    const s = shadeOf(p), selected = S.sel === p.key;
    p.layer.setStyle({ color: selected ? tok('fg') : tok('va'), weight: selected ? 3 : 1, dashArray: selected ? null : '4 3',
      fillColor: s ? tok(s.color) : 'transparent', fillOpacity: s ? s.alpha : 0 });
  }
  const restylePolls = () => polls.forEach(stylePoll);

  function renderShade() {
    const shades = SHADES.filter(s => has(s.needs));
    if (!shades.some(s => s.k === S.shade)) S.shade = 'result';
    $('shade').innerHTML = shades.map(s => `<button type="button" role="radio" data-k="${s.k}" aria-checked="${S.shade === s.k}">${s.label}</button>`).join('');
    const swatches = (list, color) => `<div class="scale">${list.map(([c, a]) => `<span style="background:color-mix(in srgb, var(--${c || color}) ${a * 100}%, var(--land))"></span>`).join('')}</div>`;
    if (S.shade === 'result') {
      $('legend').innerHTML = `<h3>2024 result at each poll’s voting place</h3>${swatches(RESULT_STEPS.map(([, , c, a]) => [c, a]))}
        <div class="scale-labels">${RESULT_LABELS.map(t => `<span>${t}</span>`).join('')}</div>
        <p>Polls that voted at the same place share its colour.</p>`;
    } else {
      const st = STEPS[S.shade];
      const edges = ['<' + st.label(st.breaks[0]), ...st.breaks.slice(0, -1).map((b, i) => `${st.label(b)}–${st.label(st.breaks[i + 1])}`), st.label(st.breaks.at(-1)) + '+'];
      $('legend').innerHTML = `<h3>${st.title}</h3>${swatches(st.alpha.map(a => [null, a]), st.color)}
        <div class="scale-labels">${edges.map(t => `<span>${t}</span>`).join('')}</div><p>${st.note}</p>`;
    }
  }
  $('shade').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    S.shade = b.dataset.k;
    renderShade();
    restylePolls();
  });

  // ------------------------------------------------------------------ poll tooltip and card
  function pollTip(p) {
    const r = S.ps && S.ps.rows.get(p.key), t = S.turnout && turnoutFor(p.key), c = castFor(p.key);
    const parts = [`<b>Poll ${p.code}</b>`];
    if (p.place) parts.push(`2024: ${leanText(lean(p.place.day))}`);
    if (c) parts.push(`${fmt(c.n)} voted so far`);
    if (r) parts.push(`${fmt(r.support)} supporters`, `${pct(r.unknown)} no answer yet`);
    if (t) parts.push(`${fmt(t.not)} didn’t vote in 2024`);
    return parts.join(' · ');
  }
  function pollCard(p) {
    const r = S.ps && S.ps.rows.get(p.key), t = S.turnout && turnoutFor(p.key), c = castFor(p.key), pl = p.place;
    let h = `<div class="pop"><h3>Poll ${p.code}</h3>`;
    if (r || t || c) {
      h += '<div class="grid">';
      if (c) h += `<div><b>${fmt(c.n)}</b><span>voted so far${c.reg ? ` (${pct(c.share, 1)} of ${fmt(c.reg)} registered)` : ''}${c.ours ? `, ${fmt(c.ours)} on our supporter lists` : ''}</span></div>`;
      if (r) h += `<div><b>${fmt(r.support)}</b><span>supporters found (${pct(r.supportPct, 1)} of ${fmt(r.pop)} people on file)</span></div>
        <div><b>${pct(r.unknown)}</b><span>no support answer yet</span></div>`;
      if (t) h += `<div><b>${fmt(t.not)}</b><span>supporters didn’t vote in 2024${t.notPhone ? `, ${fmt(t.notPhone)} with a phone` : ''}</span></div>`;
      h += '</div>';
    } else h += `<p class="meta">${fmt(p.reg2024)} registered voters (2024)</p>`;
    if (pl) h += `<h4>2024 result · ${chip(lean(pl.day))}</h4><p class="meta">Election day at ${esc(pl.name)} (polls ${runs(pl.polls)})</p>${partyBars(pl.day)}`;
    if (r && r.streets.length) h += `<details><summary>Streets in this poll</summary><div class="streets">${r.streets.map(s => `<span>${esc(s.name)} <span class="num">${s.n}</span></span>`).join('')}</div></details>`;
    return h + '</div>';
  }
  function openPoll(p, at) {
    selectPoll(p.key, false);
    L.popup({ maxWidth: 330, autoPanPaddingTopLeft: [24, 72], autoPanPaddingBottomRight: [24, 24] }).setLatLng(at || p.at).setContent(pollCard(p)).openOn(map);
  }
  function selectPoll(key, zoom) {
    S.sel = key;
    restylePolls();
    document.querySelectorAll('#pollBody tr').forEach(tr => tr.classList.toggle('sel', tr.dataset.key === key));
    const p = pollByKey.get(key);
    if (zoom && p) map.fitBounds(p.layer.getBounds(), { padding: [40, 40], animate: !reduced, maxZoom: 17 });
  }
  map.on('popupopen', () => $('legend').classList.add('aside'));
  map.on('popupclose', () => $('legend').classList.remove('aside'));
  map.on('popupclose', () => { if (S.sel) { S.sel = null; restylePolls(); document.querySelectorAll('#pollBody tr.sel').forEach(tr => tr.classList.remove('sel')); } });

  // ------------------------------------------------------------------ labels (polls, streets, households)
  const labels = L.layerGroup().addTo(map);
  function refreshLabels() {
    labels.clearLayers();
    const z = map.getZoom(), view = map.getBounds().pad(0.15);
    if (z >= 15.5) streetLabels.addTo(map); else streetLabels.remove();
    if (z >= 13.5) placeMarkers.addTo(map); else placeMarkers.remove();
    map.getContainer().classList.toggle('place-names', z >= 15);
    if (z >= 12.5 && z < 17) {
      const fits = placer();
      polls.forEach(p => {
        const pt = map.latLngToContainerPoint(p.at), w = 12 + String(p.code).length * 7;
        if (view.contains(p.at) && fits(pt.x - w / 2 - 3, pt.y - 9, w + 6, 18)) {
          labels.addLayer(L.marker(p.at, { pane: 'pollLabels', interactive: false, keyboard: false,
            icon: L.divIcon({ className: 'poll-label', iconSize: [0, 0], html: `<span>${p.code}</span>` }) }));
        }
      });
    }
    if (!S.sites.length || z < 16) return;
    const fits = z >= 19 ? () => true : placer();
    const shown = S.sites.filter(s => s.shown && view.contains(s.p));
    if (z < 19) shown.forEach(s => { const pt = map.latLngToContainerPoint(s.p), r = radius(s) + 1; fits(pt.x - r, pt.y - r, 2 * r, 2 * r); });
    shown.sort((a, b) => countFor(b) - countFor(a));
    let n = 0;
    for (const s of shown) {
      if (++n > 1500) break;
      const text = z >= 18 ? s.civic : s.civic.split(' ')[0], count = countFor(s);
      const pt = map.latLngToContainerPoint(s.p), w = text.length * 6.2 + (count > 1 ? 8 + String(count).length * 6 : 0), r = radius(s) + 3;
      let side = '';
      if (!fits(pt.x + r, pt.y - 7, w, 14)) {
        if (!fits(pt.x - r - w, pt.y - 7, w, 14)) continue;
        side = ' left';
      }
      labels.addLayer(L.marker(s.p, { pane: 'houseLabels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'house-label' + side, iconSize: [0, 0], html: `<span>${esc(text)}${count > 1 ? `<small>×${count}</small>` : ''}</span>` }) }));
    }
  }
  map.on('zoomend moveend', refreshLabels);

  // ------------------------------------------------------------------ households
  const SUPPORT = ['con', 'lean', 'sup24'], OPPOSE = ['ndp', 'ndp_lean', 'grn', 'oth'];
  const sumOf = (s, ks) => ks.reduce((t, k) => t + (s.n[k] || 0), 0);
  const VIEWS = [  // one choice at a time: what the dots on the map are
    { k: 'support', label: 'Supporters', test: s => sumOf(s, SUPPORT) > 0, count: s => sumOf(s, SUPPORT),
      key: [['con', 'Supporter'], ['ring', 'Lawn sign requested']] },
    { k: 'skipped', label: 'Didn’t vote in 2024', needs: 'lists', test: s => s.notVoted > 0, count: s => s.notVoted,
      key: [['con', 'Supporter who didn’t vote in 2024']] },
    { k: 'cast', label: 'Voted so far', needs: 'cast', test: s => s.cast > 0, count: s => s.cast,
      key: [['cast', 'Someone on our supporter lists voted'], ['castOther', 'Other voters']] },
    { k: 'oppose', label: 'Other parties', test: s => sumOf(s, OPPOSE) > 0, count: s => sumOf(s, OPPOSE),
      key: [['ndp', 'NDP'], ['grn', 'Green'], ['oth', 'Other party']] },
    { k: 'und', label: 'Undecided', test: s => (s.n.und || 0) > 0, count: s => s.n.und || 0,
      key: [['und', 'Undecided or won’t say']] },
    { k: 'all', label: 'Everyone', test: s => Object.values(s.n).some(Boolean), count: s => Object.values(s.n).reduce((t, v) => t + v, 0),
      key: [['con', 'Supporter'], ['ndp', 'NDP'], ['grn', 'Green'], ['oth', 'Other'], ['und', 'Undecided'], ['dnc', 'Do not contact']] },
  ];
  const viewOf = () => VIEWS.find(v => v.k === S.view && has(v.needs)) || VIEWS[0];
  function kindOf(s) {  // the dot's colour: supporters blue, other parties in their colour, undecided grey, do-not-contact a red ring
    const v = viewOf().k;
    if (v === 'cast') return s.castOurs ? 'cast' : 'castOther';
    if (v !== 'oppose' && v !== 'und' && (sumOf(s, SUPPORT) || v === 'skipped')) return 'con';
    if (v === 'oppose' || v === 'all') {
      if (s.n.ndp || s.n.ndp_lean) return 'ndp';
      if (s.n.grn) return 'grn';
      if (s.n.oth) return 'oth';
    }
    if (s.n.und) return 'und';
    return s.n.dnc ? 'dnc' : 'con';
  }
  const dot = k => k === 'ring' ? 'border:2.5px solid var(--sign);background:transparent' : k === 'dnc' ? 'border:2px dashed var(--dnc);background:transparent'
    : k === 'castOther' ? 'border:2px solid var(--cast);background:transparent' : `background:var(--${k})`;
  const countFor = s => s.shown ? viewOf().count(s) : 0;
  const radius = s => 4.5 + Math.min(5, Math.sqrt(Math.max(1, countFor(s))) - 1);


  const houseLayer = L.layerGroup().addTo(map);
  function buildHouses() {
    houseLayer.clearLayers();
    S.sites.forEach(s => {
      if (!s.p) return;
      s.marker = L.circleMarker(s.p, { renderer: dataCanvas, pane: 'data', radius: 5 }).bindPopup(() => houseCard(s), { maxWidth: 320, autoPanPaddingTopLeft: [24, 72], autoPanPaddingBottomRight: [24, 24] });
      if (s.ls) s.ring = L.circleMarker(s.p, { renderer: dataCanvas, pane: 'data', radius: 8, fill: false, interactive: false });
    });
    updateHouses();
  }
  function updateHouses() {
    houseLayer.clearLayers();
    const c = tokens(), v = viewOf();
    for (const s of S.sites) {
      s.shown = !!(s.p && v.test(s));
      if (!s.shown) continue;
      s.kind = kindOf(s);
      styleHouse(s, c);
      if (s.ring && (v.k === 'support' || v.k === 'all')) houseLayer.addLayer(s.ring);
      houseLayer.addLayer(s.marker);
    }
    renderViews();
    refreshLabels();
  }
  function styleHouse(s, c) {
    const r = radius(s), col = c[s.kind] || c.cast;
    const st = s.kind === 'dnc' ? { fillColor: c.surface, fillOpacity: 1, color: col, weight: 2.2, dashArray: '2 2' }
      : s.kind === 'castOther' ? { fillColor: c.surface, fillOpacity: 1, color: col, weight: 2.2, dashArray: null }
      : { fillColor: col, fillOpacity: 1, color: c.halo, weight: 1.6, dashArray: null };
    if (s.out) Object.assign(st, { fillOpacity: s.kind === 'dnc' ? 1 : 0.35, color: col, dashArray: '3 2' });
    s.marker.setStyle(st).setRadius(r);
    if (s.ring) s.ring.setStyle({ color: c.sign, weight: 2.4 }).setRadius(r + 3.5);
  }
  const tokens = () => Object.fromEntries(['fg', 'halo', 'surface', 'sign', 'va', 'con', 'ndp', 'grn', 'oth', 'und', 'dnc', 'ramp-gotv', 'cast'].map(k => [k, tok(k)]));

  function houseCard(s) {
    const line = (k, label, n) => `<li><i class="dot" style="${dot(k)}"></i><span>${label}</span><b class="num">${n}</b></li>`;
    const lines = [];
    const now = (s.n.con || 0) + (s.n.lean || 0), listed = s.voted + s.notVoted, opp = (s.n.ndp || 0) + (s.n.ndp_lean || 0);
    if (s.cast) lines.push(line(s.castOurs ? 'cast' : 'castOther', 'Voted so far (participation report)', s.cast));
    if (s.castOurs) {
      const u = [...s.castUnits].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      lines.push(`<li class="sub"><i class="dot" style="${dot('cast')}"></i><span>of them on our supporter lists${u.length ? ` (unit${u.length > 1 ? 's' : ''} ${esc(u.join(', '))})` : ''}</span><b class="num">${s.castOurs}</b></li>`);
    }
    if (now) lines.push(line('con', 'Supporters found this election', now));
    if (listed) lines.push(line('con', 'On the 2024 supporter list', listed));
    if (s.notVoted) lines.push(`<li class="sub"><i class="dot" style="${dot('ramp-gotv')}"></i><span>of them didn’t vote in 2024${s.phoneNV ? ` (${s.phoneNV} with a phone)` : ''}</span><b class="num">${s.notVoted}</b></li>`);
    if (opp) lines.push(line('ndp', 'NDP', opp));
    if (s.n.grn) lines.push(line('grn', 'Green', s.n.grn));
    if (s.n.oth) lines.push(line('oth', 'Other party', s.n.oth));
    if (s.n.und) lines.push(line('und', 'Undecided or won’t say', s.n.und));
    if (s.n.dnc) lines.push(line('dnc', 'Do not contact', s.n.dnc));
    const units = [...new Set([...s.units.keys(), ...s.vUnits.keys()])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const marked = units.some(u => s.vUnits.get(u)?.not);
    const unitHtml = units.length ? `<p class="meta units">Units${marked ? ' (<i class="dot inline" style="background:var(--ramp-gotv)"></i>didn’t vote in 2024)' : ''}: ${units.slice(0, 48).map(u =>
      `<span>${s.vUnits.get(u)?.not ? '<i class="dot inline" style="background:var(--ramp-gotv)"></i>' : ''}${esc(u)}</span>`).join('')}${units.length > 48 ? ` +${units.length - 48} more` : ''}</p>` : '';
    const flags = [];
    if (s.ls) flags.push(`<p class="flag sign">Lawn sign requested${s.ls > 1 ? ` (${s.ls})` : ''}</p>`);
    if (s.out) flags.push(`<p class="flag">Outside the ${esc(P.riding)} boundary.</p>`);
    if (s.approx) flags.push('<p class="flag">Location estimated from neighbouring house numbers.</p>');
    const meta = [`Poll ${s.va || s.poll || '?'}`, s.last ? `last contact ${day(s.last)}` : 'not contacted yet this election'];
    return `<div class="pop"><h3>${esc(s.civic)}</h3><p class="meta">${meta.join(' · ')}</p><ul class="counts">${lines.join('')}</ul>${unitHtml}${flags.join('')}</div>`;
  }

  // ------------------------------------------------------------------ reading the exports

  function turnoutFor(key) {
    const t = S.turnout && S.turnout.byPoll;
    return t && (t.get(key) || t.get(key.replace(/S$/, '')));
  }
  // voted so far in a poll, by the voting area the participation report gives each voter, against its registered voters
  function castFor(key) {
    if (!S.castBy) return null;
    const c = S.castBy.get(key) || { n: 0, ours: 0 }, reg = S.ps?.rows.get(key)?.reg || pollByKey.get(key)?.reg2024 || 0;
    return { ...c, reg, share: reg ? c.n / reg : 0 };
  }

  // one site per civic address, from the canvass answers and the turnout lists together
  function composeSites() {
    const sites = new Map();
    const get = (key, civic) => {
      let s = sites.get(key);
      if (!s) sites.set(key, s = { key, civic, polls: {}, n: {}, units: new Map(), ls: 0, last: '', voted: 0, notVoted: 0, phoneNV: 0, vUnits: new Map(), cast: 0, castOurs: 0, castUnits: new Set() });
      return s;
    };
    for (const seed of S.ix ? S.ix.seeds : []) {
      const s = get(seed.key, seed.civic);
      Object.assign(s, { polls: { ...seed.polls }, n: { ...seed.n }, units: seed.units, ls: seed.ls, last: seed.last, fromIx: true });
    }
    S.turnout = null;
    const lists = [S.lists?.voted, S.lists?.not].filter(Boolean), entries = [];
    let unplaced = 0;
    for (const list of lists) {
      for (const person of list.people) {
        const a = listAddress(person.street);
        const s = a && get(siteKey(a.civic), prettyCivic(a.civic));
        entries.push({ s, kind: list.kind, phone: person.phone, poll: person.poll });
        if (!s) { unplaced++; continue; }
        if (!s.fromIx && !NO_POLL.has(person.poll)) s.polls[person.poll] = (s.polls[person.poll] || 0) + 1;
        const u = s.vUnits.get(a.unit) || { voted: 0, not: 0 };
        s.vUnits.set(a.unit, u);
        if (list.kind === 'voted') { s.voted++; u.voted++; } else { s.notVoted++; u.not++; if (person.phone) s.phoneNV++; }
      }
    }
    // people who have voted so far, at their home; a voter who lives where we have nobody gets a site of their own
    S.castBy = S.cast ? new Map() : null;
    for (const x of castPeople(S.cast, S.voterNos)) {
      const c = S.castBy.get(x.poll) || { n: 0, ours: 0 };
      c.n++; c.ours += x.ours;
      S.castBy.set(x.poll, c);
      const a = x.street && listAddress(x.street);
      if (!a) continue;
      const k = siteKey(a.civic), s = sites.get(k) || Object.assign(get(k, prettyCivic(a.civic)), { castOnly: true });
      s.cast++;
      if (x.ours) { s.castOurs++; if (a.unit) s.castUnits.add(a.unit); }
    }
    for (const s of sites.values()) {
      if (!s.fromIx && !s.castOnly) { s.n.sup24 = s.voted + s.notVoted; s.fromList = true; }  // a "Yes" on the 2024 lists, not yet contacted this time
      const hit = locate(s.civic);
      if (hit) {
        s.p = hit.p; s.approx = hit.approx;
        s.out = !inside(s.p, P.outline);
        s.va = s.out ? null : polls.find(p => inside(s.p, p.rings))?.code ?? null;
      }
      s.poll = Object.entries(s.polls).sort((a, b) => b[1] - a[1])[0]?.[0] ?? (s.va ? String(s.va) : '');
      s.pollFromMap = !Object.keys(s.polls).length && !!s.va;
    }
    if (lists.length) {
      const byPoll = new Map();
      let mapped = 0;
      for (const e of entries) {  // a person with no poll on the list takes the poll their address falls in
        let key = e.poll;
        if (NO_POLL.has(key) && e.s?.va) { key = String(e.s.va); mapped++; }
        const t = byPoll.get(key) || { voted: 0, not: 0, notPhone: 0 };
        byPoll.set(key, t);
        if (e.kind === 'voted') t.voted++; else { t.not++; if (e.phone) t.notPhone++; }
      }
      const sum = k => [...byPoll.values()].reduce((t, v) => t + v[k], 0);
      const noPoll = (byPoll.get('999')?.voted || 0) + (byPoll.get('999')?.not || 0);
      S.turnout = { byPoll, unplaced, mapped, noPoll, voted: sum('voted'), not: sum('not'), notPhone: sum('notPhone'), lists };
    }
    S.sites = [...sites.values()];
    if (S.turnout) S.turnout.notInside = S.sites.reduce((t, s) => t + (s.p && !s.out ? s.notVoted : 0), 0);
  }

  function afterLoad() {
    composeSites();
    buildHouses();
    setBreaks();
    renderAll();
  }
  async function loadFiles(files) {
    const errors = [];
    let cast = false, other = false;
    for (const f of files) {
      try {
        const rows = await readWorkbook(f);
        const [kind, head] = sniff(rows);
        if (kind === 'cast') { S.cast = mergeCast(S.cast, parseCast(rows, head, f)); castSave(S.cast); cast = true; continue; }
        other = true;
        if (kind === 'ps') S.ps = parsePollSummary(rows, head, f);
        else if (kind === 'ix') S.ix = parseInteractions(rows, head, f);
        else if (kind === 'list') { const l = parseList(rows, head, f, listKind(f.name)); S.lists = { ...S.lists, [l.kind]: l }; }
        else if (kind === 'voterNos') S.voterNos = parseVoterNos(rows, head, f);
        else errors.push(`${f.name} isn’t a Poll Summary, Interactions export, voting list or Elections BC participation report. The Poll Summary starts with a “Poll, City, Reg Voters” header row; the Interactions export has a “Date, Voter, Poll, Address” table; a voting list has “Phone, Poll, Street, Voter_ID” columns; the participation report is the VotingParticipationReport .csv.`);
      } catch (e) {
        errors.push(`${f.name} couldn’t be read: ${e.message}`);
      }
    }
    $('loadError').hidden = !errors.length;
    $('loadError').textContent = errors.join(' ');
    if (other) S.builtIn = false;  // a participation report adds to the team's data rather than replacing it
    if (cast) { S.shade = 'cast'; S.view = 'cast'; }
    afterLoad();
    if (S.sites.length && !S.ps) selectTab('homes');
  }
  $('files').addEventListener('change', e => { loadFiles([...e.target.files]); e.target.value = ''; });
  $('clearData').addEventListener('click', () => {
    S.ps = null; S.ix = null; S.lists = null; S.turnout = null; S.cast = null; S.voterNos = null; S.castBy = null; S.sites = []; S.sort = null; S.builtIn = false; S.view = 'support';
    castSave(null);
    houseLayer.clearLayers();
    S.shade = 'result';
    map.closePopup();
    renderAll();
    if (ENC) lock();
  });
  $('castClear').addEventListener('click', () => {
    S.cast = null;
    castSave(null);
    if (S.shade === 'cast') S.shade = 'result';
    if (S.view === 'cast') S.view = 'support';
    map.closePopup();
    afterLoad();
  });

  // ------------------------------------------------------------------ built-in data, decrypted with the team password (core.js)
  function applyBuiltIn(d) {
    const ps = d.ps && sniff(d.ps.rows), ix = d.ix && sniff(d.ix.rows);
    if (ps && ps[0] === 'ps') S.ps = parsePollSummary(d.ps.rows, ps[1], { name: d.ps.name });
    if (ix && ix[0] === 'ix') S.ix = parseInteractions(d.ix.rows, ix[1], { name: d.ix.name });
    for (const l of d.lists || []) S.lists = { ...S.lists, [l.kind]: listFromRows(l) };
    S.voterNos = d.voterNos ? voterNosFromRows(d.voterNos) : null;
    S.cast = castSaved();  // a participation report loaded on either map earlier in this tab
    if (S.cast) S.shade = 'cast';
    S.builtIn = true;
    afterLoad();
  }
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('dropzone').hidden = false; } });
  addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').hidden = true;
    loadFiles([...e.dataTransfer.files]);
  });

  // ------------------------------------------------------------------ overview
  function renderOverview() {
    const ps = S.ps, ix = S.ix, tv = S.turnout;
    const cast = S.cast;
    const loaded = [ps && `poll summary${ps.asOf ? ` (${day(ps.asOf)})` : ''}`, ix && `canvass ${day(ix.earliest)} – ${day(ix.latest)}`, tv && '2024 voting lists',
      cast && `participation report${cast.names.length > 1 ? `s (${cast.names.length})` : ''}${cast.asOf ? ` to ${stamp(cast.asOf)}` : ''}`].filter(Boolean);
    $('loader').classList.toggle('done', loaded.length > 0);
    $('loaded').hidden = !loaded.length;
    $('loaded').textContent = loaded.length ? `Loaded: ${loaded.join(' · ')}` : '';
    $('chooseLabel').textContent = loaded.length ? 'Load newer files' : 'Choose files';
    $('chooseLabel').classList.toggle('primary', !loaded.length);
    $('clearData').hidden = !loaded.length;
    $('clearData').textContent = S.builtIn && ENC ? 'Lock' : 'Clear';
    $('castClear').hidden = !cast;

    const win = total.ndp + 1;
    let h = '';
    if (cast) {
      const all = [...S.castBy.values()], n = all.reduce((t, c) => t + c.n, 0), ours = all.reduce((t, c) => t + c.ours, 0);
      h += `<h2>Voted so far</h2><div class="goal"><p class="hero"><b>${fmt(n)}</b> people have voted</p>
        <p>${fmt(ours)} of them are on our supporter lists. From the Elections BC participation report${cast.asOf ? ` of ${stamp(cast.asOf)}` : ''}; load each new report as it comes.</p></div>
        ${S.sites.length ? '<div class="actions"><button type="button" class="btn" data-go="cast">Map who has voted</button></div>' : ''}`;
    }
    if (ps || tv) {
      h += '<h2>This election</h2>';
      if (ps) {
        h += `<div class="goal"><p class="hero"><b>${fmt(ps.totals.support)}</b> supporters found</p>
          <p>The Poll Summary’s current support count${ps.asOf ? ` on ${day(ps.asOf)}` : ''}. For scale, the NDP won with ${fmt(total.ndp)} votes in 2024${tv ? `, and only ${pct(tv.voted / (tv.voted + tv.not))} of the supporters on the 2024 lists voted` : ''}.</p></div>`;
      }
      h += '<div class="kpis">';
      if (ps) h += `<div class="kpi"><b>${fmt(ps.totals.pop - ps.totals.noAnswer)}</b><span>people have given a support answer (${pct(1 - ps.totals.unknown)} of the ${fmt(ps.totals.pop)} on file)</span></div>`;
      if (tv) h += `<div class="kpi"><b>${fmt(tv.notInside)}</b><span>supporters living in the riding didn’t vote in 2024</span></div>`;
      h += '</div>';
      if (S.sites.length) h += `<div class="actions"><button type="button" class="btn primary" data-go="support">Map supporters</button>${tv ? '<button type="button" class="btn" data-go="skipped">Map 2024 non-voters</button>' : ''}</div>`;
    }
    $('canvass').innerHTML = h;

    const fd = sumWays(['Final voting']);
    const early = [['advance voting', ['Advance voting']], ['mail-in', ['Vote by mail']], ['special voting', ['Special voting']]]
      .map(([n, k]) => [n, sumWays(k)]).filter(([, t]) => t.ndp > t.con).map(([n, t]) => `${n} by ${fmt(t.ndp - t.con)}`);
    const list = early.length > 1 ? `${early.slice(0, -1).join(', ')} and ${early.at(-1)}` : early[0] || '';
    $('result2024').innerHTML = `<h2>2024 result</h2><p class="headline">NDP won by ${fmt(total.ndp - total.con)} votes</p>${partyBars(total, true)}
      ${fd.con > fd.ndp && list ? `<p class="note" style="margin-top:10px">Conservatives won election day by ${fmt(fd.con - fd.ndp)}; the NDP won ${list}.</p>` : ''}`;
  }
  $('canvass').addEventListener('click', e => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    S.view = b.dataset.go;
    S.shade = b.dataset.go === 'skipped' || b.dataset.go === 'cast' ? b.dataset.go : S.ps ? 'support' : 'result';
    renderShade();
    restylePolls();
    updateHouses();
    selectTab('homes');
    if (phone()) setSheet(false);
  });

  // ------------------------------------------------------------------ polls table
  const COLS = [
    { k: 'code', label: 'Poll', get: r => r.sortCode, show: r => esc(r.label) },
    { k: 'lean', label: '2024', get: r => r.lean ?? -999, show: r => r.lean == null ? '—' : chip(r.lean), r: true },
    { k: 'reg', label: 'Voters', get: r => r.reg, show: r => fmt(r.reg), r: true, when: () => !S.ps },
    { k: 'support', label: 'Supporters', get: r => r.support, show: r => fmt(r.support), r: true, when: () => !!S.ps },
    { k: 'unknown', label: 'No answer', get: r => r.unknown, show: r => pct(r.unknown), r: true, when: () => !!S.ps },
    { k: 'skipped', label: 'Didn’t vote ’24', get: r => r.skipped, show: r => fmt(r.skipped), r: true, when: () => !!S.turnout },
    { k: 'cast', label: 'Voted', get: r => r.cast, show: r => fmt(r.cast), r: true, when: () => !!S.cast },
  ];
  function pollRows() {
    const row = (key, label, sortCode, lean_, r, reg, onMap) => ({ key, label, sortCode, lean: lean_, reg, onMap,
      support: r?.support ?? 0, unknown: r?.unknown ?? 0, skipped: turnoutFor(key)?.not ?? 0, cast: castFor(key)?.n ?? 0 });
    const rows = polls.map(p => { const r = S.ps?.rows.get(p.key); return row(p.key, String(p.code), p.code, p.place ? lean(p.place.day) : null, r, r ? r.reg : p.reg2024, true); });
    if (S.ps) for (const r of S.ps.rows.values()) {
      if (r.onMap || !r.reg) continue;  // site-based polls (care homes, apartments) have no area on the map
      rows.push(row(r.key, r.key, parseInt(r.key, 10) + 0.5, null, r, r.reg, false));
    }
    return rows;
  }
  function renderPolls() {
    const cols = COLS.filter(c => !c.when || c.when());
    const sort = S.sort && cols.some(c => c.k === S.sort.k) ? S.sort : { k: 'code', dir: 1 };
    const col = cols.find(c => c.k === sort.k);
    const rows = pollRows().sort((a, b) => (col.get(a) - col.get(b)) * sort.dir || a.sortCode - b.sortCode);
    $('pollHead').innerHTML = cols.map(c => `<th class="${c.r ? 'r' : ''}" ${c.k === sort.k ? `aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" data-k="${c.k}">${c.label}</button></th>`).join('');
    $('pollBody').innerHTML = rows.map(r => `<tr class="${r.onMap ? 'go' : ''}${r.key === S.sel ? ' sel' : ''}" ${r.onMap ? 'tabindex="0"' : ''} data-key="${esc(r.key)}">${cols.map(c => `<td class="${c.r ? 'r' : ''}">${c.show(r)}</td>`).join('')}</tr>`).join('');
    const notes = ['<b>2024</b> is the result at the poll’s 2024 voting place.'];
    if (S.ps) notes.push('<b>Supporters</b> and <b>No answer</b> (share of people on file with no support answer) come from the Poll Summary.');
    if (S.turnout) notes.push('<b>Didn’t vote ’24</b> counts supporters on the 2024 didn’t-vote list.');
    if (S.cast) notes.push('<b>Voted</b> counts everyone in the participation report so far.');
    notes.push('Click a column to sort, or a poll to see it on the map.');
    $('pollsNote').innerHTML = notes.join(' ');
  }
  $('pollHead').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    S.sort = S.sort?.k === k ? { k, dir: -S.sort.dir } : { k, dir: k === 'code' ? 1 : -1 };
    renderPolls();
  });
  function goPoll(key) {
    const p = pollByKey.get(key);
    if (!p) return;
    selectPoll(key, true);
    map.once('moveend', () => openPoll(p, p.at));
    if (phone()) setSheet(false);
  }
  $('pollBody').addEventListener('click', e => { const tr = e.target.closest('tr.go'); if (tr) goPoll(tr.dataset.key); });
  $('pollBody').addEventListener('keydown', e => { const tr = e.target.closest('tr.go'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); goPoll(tr.dataset.key); } });

  // ------------------------------------------------------------------ households tab
  function renderViews() {
    const placed = S.sites.filter(s => s.p), v = viewOf();
    $('views').innerHTML = VIEWS.filter(x => has(x.needs)).map(x => `<button type="button" class="chip-btn" data-view="${x.k}" aria-pressed="${v.k === x.k}">${x.label} <span class="num">${fmt(placed.filter(x.test).length)}</span></button>`).join('');
    $('key').innerHTML = v.key.filter(([k]) => k !== 'ring' || S.sites.some(s => s.ls)).map(([k, label]) => `<span><i class="dot" style="${dot(k)}"></i>${label}</span>`).join('') +
      '<p>The number next to an address is how many people there. Faded dashed dots are outside the riding.</p>';
  }
  $('views').addEventListener('click', e => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    S.view = b.dataset.view;
    updateHouses();
  });
  function renderHomes() {
    const any = S.sites.length > 0;
    $('homesEmpty').hidden = any;
    $('homes').hidden = !any;
    if (!any) return;
    renderViews();
    $('addrs').innerHTML = S.sites.filter(s => s.p).map(s => `<option value="${esc(s.civic)}"></option>`).join('');
    const ours = S.sites.filter(s => !s.castOnly);  // the address check is about our lists, not every voter in the report
    const placed = ours.filter(s => s.p), out = placed.filter(s => s.out), missing = ours.filter(s => !s.p);
    const moved = placed.filter(s => !s.out && s.va && String(s.va) !== s.poll && !/S$/.test(s.poll) && s.poll !== '999'), approx = placed.filter(s => s.approx);
    const list = (arr, meta, go) => `<ul class="addr-list">${arr.map((s, i) => go
      ? `<li><button type="button" data-list="${go}" data-i="${i}">${esc(s.civic)} <span class="meta">${meta(s)}</span></button></li>`
      : `<li>${esc(s.civic)} <span class="meta">${meta(s)}</span></li>`).join('')}</ul>`;
    $('check').innerHTML = `<summary>Address check: ${fmt(placed.length - out.length)} in the riding, ${fmt(missing.length + out.length)} outside or not found</summary>
      <ul class="check-list">
        <li><b>${fmt(placed.length - out.length)}</b><span>addresses placed inside ${esc(P.riding)}${approx.length ? ` (${fmt(approx.length)} estimated from neighbouring house numbers)` : ''}</span></li>
        <li><b>${fmt(out.length)}</b><span>elsewhere in Surrey, outside the boundary</span></li>
        <li><b>${fmt(missing.length)}</b><span>not found: another city, or a street the address list doesn’t know</span></li>
        <li><b>${fmt(moved.length)}</b><span>with a poll number that differs from the official map</span></li></ul>
      ${out.length ? `<details><summary>Outside the boundary</summary>${list(out, s => `poll ${esc(s.poll)}`, 'out')}</details>` : ''}
      ${moved.length ? `<details><summary>Poll differs from the map</summary>${list(moved, s => `poll ${esc(s.poll)} → ${vaName(s.va)}`, 'moved')}</details>` : ''}
      ${missing.length ? `<details><summary>Not found</summary>${list(missing, s => `poll ${esc(s.poll)}`)}</details>` : ''}
      ${S.turnout?.unplaced ? `<p class="note">${fmt(S.turnout.unplaced)} people on the 2024 lists have no usable address (blank or “N/A”).</p>` : ''}`;
    S.checkLists = { out, moved };
  }
  $('check').addEventListener('click', e => { const b = e.target.closest('button[data-list]'); if (b) showHouse(S.checkLists[b.dataset.list][+b.dataset.i]); });
  function showHouse(s) {
    if (!s || !s.p) return;
    if (!s.shown) { S.view = Object.values(s.n).some(Boolean) ? 'all' : 'cast'; updateHouses(); }  // a voter not on our lists shows only among voters
    map.setView(s.p, 18, { animate: !reduced });
    s.marker.openPopup();
    if (phone()) setSheet(false);
  }
  $('find').addEventListener('change', e => {
    const q = e.target.value.trim().toLowerCase();
    if (!q || !S.sites.length) return;
    const sites = S.sites.filter(s => s.p);
    showHouse(sites.find(s => s.civic.toLowerCase() === q) || sites.find(s => s.civic.toLowerCase().startsWith(q)) || sites.find(s => s.civic.toLowerCase().includes(q)));
  });
  $('downloadCsv').addEventListener('click', () => {
    const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const rows = [['address', 'units', 'poll', 'supporters', 'other parties', 'undecided', 'do not contact', 'did not vote in 2024', 'with a phone',
      'lawn signs', 'last contact', 'voted so far', 'of them on our lists', 'location', 'lat', 'lon']];
    S.sites.filter(s => s.shown).forEach(s => rows.push([s.civic, [...new Set([...s.units.keys(), ...s.vUnits.keys()])].filter(Boolean).join(' '),
      s.va || s.poll, sumOf(s, SUPPORT), sumOf(s, OPPOSE), s.n.und || 0, s.n.dnc || 0, s.notVoted, s.phoneNV, s.ls, s.last, S.cast ? s.cast : '', S.cast ? s.castOurs : '',
      s.approx ? 'estimated' : 'address point', s.p[0].toFixed(5), s.p[1].toFixed(5)]));
    const url = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${P.code.toLowerCase()}-${viewOf().k}-households.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ------------------------------------------------------------------ tabs and phone sheet
  const TABS = ['overview', 'polls', 'homes', 'voted'];
  function selectTab(name) {
    TABS.forEach(t => {
      const tab = $('tab-' + t), sel = t === name;
      tab.setAttribute('aria-selected', sel);
      tab.tabIndex = sel ? 0 : -1;
      $('pane-' + t).hidden = !sel;
    });
    $('panelBody').scrollTop = 0;
  }
  document.querySelector('.tabs').addEventListener('click', e => { const t = e.target.closest('[role="tab"]'); if (t) selectTab(t.id.slice(4)); });
  document.querySelector('.tabs').addEventListener('keydown', e => {
    const i = TABS.indexOf(document.activeElement.id.slice(4));
    if (i < 0 || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    selectTab(next);
    $('tab-' + next).focus();
  });
  const setSheet = sheet(app);

  // ------------------------------------------------------------------ theme
  function applyTheme() {
    styleBase();
    restylePolls();
    if (S.sites.length) { const c = tokens(); S.sites.forEach(s => { if (s.shown) styleHouse(s, c); }); }
  }
  onTheme(applyTheme);

  function renderAll() {
    renderShade();
    renderOverview();
    renderPolls();
    renderHomes();
    voted.refresh();
    restylePolls();
    refreshLabels();
  }

  $('eyebrow').textContent = `${P.riding} · ${P.code}`;
  if (phone()) setSheet(false);
  renderAll();
  applyTheme();
  const lock = gate(applyBuiltIn);
})();
