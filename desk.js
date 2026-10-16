'use strict';
// Check-in desk on GitHub Pages. The shared state lives in the campaign's Firebase Realtime Database (desk-config.js names it),
// so any laptop that opens desk.html gets the same board with no login or setup. It is one JSON document: the route book, who
// has each route and what came back, and the one-volunteer-per-poll setting. Every change is a Firebase transaction against the
// latest version, so two devices can never claim the same route (the second one re-runs against the new board and is refused).
// Volunteers type their names; no voter data is stored: routes carry polls, door counts and street names only.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const key = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const tidy = s => String(s || '').trim().replace(/\s+/g, ' ');
const clock = iso => iso ? new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '';
const hm = min => min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')}`;
const since = iso => hm(Math.max(0, (Date.now() - Date.parse(iso)) / 60000));
const MAP_URL = 'polls.html';

const S = { ready: false, canAdmin: true, routes: [], desk: new Map(), meta: null,
  settings: { onePerPoll: true }, view: 'checkin', flow: { step: 'ask' } };

// ------------------------------------------------------------------ the shared desk in Firebase
// The whole desk is stored as one JSON string at /desk/state (a string keeps Firebase from reshaping empty lists and objects).
const empty = () => ({ kind: 'scc-desk', version: 1, routes: [], meta: null, settings: { onePerPoll: true }, desk: {} });
const parse = v => { if (typeof v !== 'string' || !v) return empty(); try { return { ...empty(), ...JSON.parse(v) }; } catch (x) { return empty(); } };
const store = {
  ref: null, online: false, state: empty(), listeners: [],
  // open the database and resolve with the first copy of the desk; later changes from other devices arrive by themselves
  connect(cfg) {
    const app = firebase.initializeApp({ databaseURL: cfg.databaseURL }, 'desk');
    const db = app.database();
    if (cfg.emulator) db.useEmulator(cfg.emulator[0], cfg.emulator[1]);
    db.ref('.info/connected').on('value', snap => { this.online = snap.val() === true; this.onLine?.(this.online); });
    this.ref = db.ref('desk/state');
    return new Promise((resolve, reject) => {
      let first = true;
      this.ref.on('value', snap => {
        this.state = parse(snap.val());
        if (first) { first = false; resolve(); } else this.emit();
      }, err => { if (first) { first = false; reject(err); } else banner(friendly(err)); });
    });
  },
  // change the desk: Firebase runs `change` on the latest version and saves only if nobody saved in between (otherwise it runs
  // it again on the newer version). `change` returning false means "not any more" (say, the route was just taken): nothing saved.
  async write(change) {
    if (!this.online) throw { status: 'offline' };
    const tx = this.ref.transaction(cur => {
      const next = parse(cur);
      if (change(next) === false) return undefined;
      return JSON.stringify(next);
    }, undefined, false);
    const late = new Promise((_, reject) => setTimeout(() => reject({ status: 'slow' }), 20000));
    const res = await Promise.race([tx, late]);
    if (!res.committed) return false;
    this.state = parse(res.snapshot.val());
    this.emit();
    return true;
  },
  emit() { this.listeners.forEach(fn => fn(this.state)); },
};

// ------------------------------------------------------------------ derived state
const deskOf = id => S.desk.get(id) || { status: 'open', history: [] };
const isOut = id => deskOf(id).status === 'out';
const isDone = id => deskOf(id).status === 'done';
const isPartly = id => { const d = deskOf(id); return d.status === 'open' && d.resumeAt > 1; };
function busyPolls() {
  const busy = new Map();
  for (const r of S.routes) if (isOut(r.id)) for (const p of r.polls) busy.set(p, [...(busy.get(p) || []), deskOf(r.id).name]);
  return busy;
}
function pollStates() {
  const by = new Map();
  for (const r of S.routes) for (const p of r.polls) (by.get(p) || by.set(p, []).get(p)).push(r);
  return [...by.entries()].sort((a, b) => +a[0] - +b[0]).map(([poll, rs]) => {
    const out = rs.filter(r => isOut(r.id)), done = rs.filter(r => isDone(r.id));
    const state = out.length ? 'out' : done.length === rs.length ? 'done' : done.length || rs.some(r => isPartly(r.id)) ? 'part' : 'open';
    return { poll, rs, state, names: out.map(r => deskOf(r.id).name) };
  });
}
// the next route for a volunteer: book order, open routes only, and (unless switched off) none in a poll someone is already in
function candidates() {
  const open = S.routes.filter(r => deskOf(r.id).status === 'open');
  if (!S.settings.onePerPoll) return { fit: open, crowded: [] };
  const busy = busyPolls();
  return { fit: open.filter(r => !r.polls.some(p => busy.has(p))), crowded: open.filter(r => r.polls.some(p => busy.has(p))) };
}
const routeOutFor = name => S.routes.find(r => isOut(r.id) && deskOf(r.id).nameKey === key(name));
const where = r => r.place ? `${r.area} · ${r.place}` : r.area;
const pollsText = r => `Poll${r.polls.length > 1 ? 's' : ''} ${r.polls.join(', ')}`;

// ------------------------------------------------------------------ writes
function friendly(e) {
  if (e && /permission/i.test(e.code || e.message || '')) return 'The desk’s database refused the save. Its rules need to allow the desk (see the setup notes).';
  if (e && e.status === 'slow') return 'The desk is taking a long time to save. Check the board before trying again.';
  return 'The desk can’t reach the internet just now. Check the connection and try again.';
}
// claim a route for a name: saved only if, in the latest version of the desk, the route is still free (and, unless the route was
// picked by hand, still in a poll nobody else is in)
async function claim(route, name, picked) {
  return store.write(st => {
    const prev = st.desk[route.id];
    if (!st.routes.some(r => r.id === route.id) || (prev && prev.status !== 'open')) return false;
    if (!picked && st.settings?.onePerPoll !== false) {
      const busy = new Set(st.routes.filter(r => st.desk[r.id]?.status === 'out').flatMap(r => r.polls));
      if (route.polls.some(p => busy.has(p))) return false;
    }
    if (Object.entries(st.desk).some(([, d]) => d.status === 'out' && d.nameKey === key(name))) return false;  // one route per person
    st.desk[route.id] = { status: 'out', name: tidy(name), nameKey: key(name), outAt: new Date().toISOString(), resumeAt: prev?.resumeAt || 0, history: prev?.history || [] };
  }, `${tidy(name)} took ${route.id}`);
}
async function giveRoute(name, chosen) {
  const tryList = chosen ? [chosen] : candidates().fit;
  for (const r of tryList) {
    if (await claim(r, name, !!chosen)) return r;
    apply(store.state);  // someone else took it: look again at the latest desk
  }
  return null;
}
async function bringBack(route, f) {
  let who = '';
  await store.write(st => {
    const d = st.desk[route.id];
    if (!d || d.status !== 'out') return false;  // already handed in from another device
    const now = new Date().toISOString();
    who = d.name;
    const entry = { name: d.name, outAt: d.outAt, backAt: now, knocked: f.knocked, home: f.home, rides: f.rides, finished: f.finished, stoppedAt: f.finished ? 0 : f.stoppedAt, note: f.note };
    st.desk[route.id] = { status: f.finished ? 'done' : 'open', name: f.finished ? d.name : '', nameKey: '', outAt: '', backAt: now,
      resumeAt: f.finished ? 0 : (f.stoppedAt || 0) + 1, history: [...(d.history || []), entry] };
  }, `${deskOf(route.id).name || 'Someone'} handed in ${route.id}${f.finished ? '' : ` (stopped at ${f.stoppedAt})`}`);
  return who;
}
async function release(route) {
  await store.write(st => {
    const d = st.desk[route.id];
    if (!d || d.status !== 'out') return false;
    st.desk[route.id] = { status: 'open', name: '', nameKey: '', outAt: '', resumeAt: d.resumeAt || 0,
      history: [...(d.history || []), { name: d.name, outAt: d.outAt, backAt: new Date().toISOString(), released: true }] };
  }, `Released ${route.id}`);
}
async function reopen(route) {
  await store.write(st => {
    const d = st.desk[route.id];
    if (!d) return false;
    st.desk[route.id] = { status: 'open', name: '', nameKey: '', outAt: '', resumeAt: 0, history: d.history || [] };
  }, `Reopened ${route.id}`);
}

// take a route off the board (not while someone is out on it); loading the route book again brings it back
async function removeRoute(route) {
  return store.write(st => {
    if (st.desk[route.id]?.status === 'out' || !st.routes.some(r => r.id === route.id)) return false;
    st.routes = st.routes.filter(r => r.id !== route.id);
    delete st.desk[route.id];
    if (st.meta) st.meta.count = st.routes.length;
  }, `Removed ${route.id}`);
}

// ------------------------------------------------------------------ volunteer side
function setFlow(flow) { S.flow = flow; renderKiosk(); }
function ticket(r, name, fresh) {
  const d = deskOf(r.id), resume = d.resumeAt > 1;
  return `<div class="ticket">
    <p class="for">${fresh ? `${esc(name)}, your route is` : `${esc(name)} has route`}</p>
    <p class="code">${esc(r.id)}</p>
    <p class="where">${esc(where(r))} · ${esc(pollsText(r))}</p>
    <div class="facts"><div><b>${r.doors}</b><span>doors</span></div><div><b>${r.km} km</b><span>walking</span></div><div><b>${hm(r.minutes)}</b><span>about</span></div></div>
    <p class="streets"><b>Streets:</b> ${esc(r.streets.join(', '))}</p>
    ${resume ? `<p class="pick"><b>Partly done.</b> Start at stop ${d.resumeAt} on the house sheet; the doors before it were knocked.</p>` : ''}
    <p class="pick">Take packet <b>${esc(r.id)}</b> from the desk: the route map and the house sheet. Tick Home, Not home, Ride and Voted as you go.</p>
    ${r.area === 'Other polls' ? '<p class="note">These doors are spread out. A car helps.</p>' : ''}
  </div>`;
}
function renderKiosk() {
  const k = $('kiosk'), f = S.flow;
  if (!S.ready) { k.innerHTML = `<div class="empty"><h2>Connecting to the desk…</h2><p class="note">Reading the shared board.</p></div>`; return; }
  if (!S.routes.length) { k.innerHTML = `<div class="empty"><h2>No routes loaded yet</h2><p class="note">The coordinator loads the route book on the Board tab. It comes from the Poll map: Routes tab, then “Build the route book”.</p></div>`; return; }
  if (f.step === 'ask') {
    const left = candidates(), open = S.routes.filter(r => deskOf(r.id).status === 'open').length;
    k.innerHTML = `<div><h2>Here to knock on doors?</h2><p class="lead">Type your name. You’ll get a route nobody else is on${S.settings.onePerPoll ? ', in a poll nobody else is in' : ''}. Coming back? Type the same name.</p></div>
      <form class="namebox" id="nameForm" autocomplete="off"><input id="vName" name="vName" placeholder="First and last name" aria-label="Your name" required maxlength="60">
        <button class="btn go" type="submit" id="vGo">Continue</button></form>
      <p class="err" id="vErr" role="alert"></p>
      <p class="note">${open} of ${S.routes.length} routes are free${S.settings.onePerPoll && left.crowded.length ? `, ${left.fit.length} of them in polls with nobody out` : ''}.</p>`;
    $('nameForm').addEventListener('submit', onName);
    setTimeout(() => $('vName')?.focus(), 0);
    return;
  }
  if (f.step === 'assigned' || f.step === 'already') {
    k.innerHTML = ticket(f.route, f.name, f.step === 'assigned') + `<div class="row">
      ${f.step === 'already' ? `<button class="btn go" type="button" data-act="back">I’m back: hand in ${esc(f.route.id)}</button>` : ''}
      <button class="btn primary" type="button" data-act="next">Done, next volunteer</button></div>`;
    return;
  }
  if (f.step === 'none') {
    const c = candidates();
    k.innerHTML = `<div><h2>${c.crowded.length ? 'Every free route is in a poll someone is already in' : 'Every route is taken or done'}</h2>
      <p class="lead">${c.crowded.length ? `These routes don’t share any doors with the people out now, so ${esc(f.name)} can still take one:` : 'Ask the coordinator for the next area. Thank you for coming in.'}</p></div>
      ${c.crowded.length ? `<div class="choice">${c.crowded.slice(0, 6).map(r => `<button class="btn" type="button" data-take="${esc(r.id)}"><b>${esc(r.id)}</b>&nbsp;· ${esc(pollsText(r))} · ${r.doors} doors · with ${esc((busyPolls().get(r.polls.find(p => busyPolls().has(p))) || []).join(', '))} in the poll</button>`).join('')}</div>` : ''}
      <p class="err" id="vErr" role="alert"></p>
      <div class="row"><button class="btn quiet" type="button" data-act="next">Back</button></div>`;
    return;
  }
  if (f.step === 'return') { k.innerHTML = returnForm(f.route, 'kiosk'); wireReturn(k, f.route, () => setFlow({ step: 'thanks', route: f.route, name: f.name })); return; }
  if (f.step === 'thanks') {
    const d = deskOf(f.route.id), last = (d.history || []).at(-1) || {};
    k.innerHTML = `<div class="ticket"><p class="for">Thank you, ${esc(f.name)}</p><p class="code">${esc(f.route.id)}</p>
      <p class="where">${last.finished ? 'Route finished.' : `Back on the board from stop ${d.resumeAt} for the next person.`}${last.rides ? ` ${last.rides} ride${last.rides > 1 ? 's' : ''} needed: the office will call.` : ''}</p></div>
      <div class="row"><button class="btn go" type="button" data-act="again">Get another route</button><button class="btn primary" type="button" data-act="next">Done, next volunteer</button></div>`;
  }
}
async function onName(e) {
  e.preventDefault();
  const name = tidy($('vName').value);
  if (name.length < 2) { $('vErr').textContent = 'Type your name to continue.'; return; }
  const out = routeOutFor(name);
  if (out) return setFlow({ step: 'already', route: out, name: deskOf(out.id).name || name });
  await assign(name);
}
async function assign(name, chosen) {
  const btn = $('vGo');
  if (btn) { btn.disabled = true; btn.textContent = 'Finding a route…'; }
  try {
    const r = await giveRoute(name, chosen);
    setFlow(r ? { step: 'assigned', route: r, name } : { step: 'none', name });
  } catch (x) {
    setFlow({ step: 'ask' });
    $('vErr').textContent = friendly(x);
  }
}
$('kiosk').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  const f = S.flow;
  if (b.dataset.act === 'next') return setFlow({ step: 'ask' });
  if (b.dataset.act === 'back') return setFlow({ step: 'return', route: f.route, name: f.name });
  if (b.dataset.act === 'again') return assign(f.name);
  if (b.dataset.take) {
    const r = S.routes.find(x => x.id === b.dataset.take);
    b.disabled = true;
    try { const got = await giveRoute(f.name, r); setFlow(got ? { step: 'assigned', route: got, name: f.name } : { step: 'none', name: f.name }); }
    catch (x) { $('vErr').textContent = friendly(x); b.disabled = false; }
  }
});

// the hand-in form, used by volunteers and on the board
function returnForm(r, where_) {
  const d = deskOf(r.id);
  return `<form class="form" id="retForm" data-where="${where_}">
    <h3 style="margin:0;font:800 22px/1.2 var(--display)">Hand in ${esc(r.id)}</h3>
    <p class="note">${esc(d.name)} took it at ${clock(d.outAt)} (${since(d.outAt)} ago). Count from the house sheet.</p>
    <div class="three">
      <label class="field">Doors knocked<input id="fKnocked" type="number" min="0" max="${r.doors}" inputmode="numeric" required></label>
      <label class="field">People home<input id="fHome" type="number" min="0" inputmode="numeric" value="0"></label>
      <label class="field">Rides needed<input id="fRides" type="number" min="0" inputmode="numeric" value="0"></label>
    </div>
    <div class="field" style="display:grid;gap:6px;font-weight:600;font-size:14px">Did you finish the route?
      <div class="seg" role="group" aria-label="Finished"><button type="button" data-fin="yes" aria-pressed="true">Yes, every door</button><button type="button" data-fin="no" aria-pressed="false">No, I stopped early</button></div></div>
    <label class="field" id="fStopWrap" hidden>Last stop knocked <small>The next person starts at the stop after it.</small><input id="fStop" type="number" min="1" max="${r.doors}" inputmode="numeric"></label>
    <label class="field">Notes for the office <small>Optional. Rides: write the address and time on the house sheet too.</small><input id="fNote" maxlength="200"></label>
    <p class="err" id="fErr" role="alert"></p>
    <div class="row"><button class="btn go" type="submit" id="fSave">Hand it in</button><button class="btn quiet" type="button" data-cancel>Cancel</button></div>
  </form>`;
}
function wireReturn(root, r, after) {
  const form = root.querySelector('#retForm');
  let finished = true;
  form.addEventListener('click', e => {
    const fin = e.target.closest('[data-fin]');
    if (fin) {
      finished = fin.dataset.fin === 'yes';
      form.querySelectorAll('[data-fin]').forEach(b => b.setAttribute('aria-pressed', b === fin));
      form.querySelector('#fStopWrap').hidden = finished;
    }
    if (e.target.closest('[data-cancel]')) { if (form.dataset.where === 'kiosk') setFlow({ step: 'ask' }); else closeOverlay(); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const n = id => Math.max(0, Math.round(+form.querySelector(id).value || 0));
    const f = { knocked: n('#fKnocked'), home: n('#fHome'), rides: n('#fRides'), finished, stoppedAt: n('#fStop'), note: tidy(form.querySelector('#fNote').value) };
    if (!finished && !f.stoppedAt) { form.querySelector('#fErr').textContent = 'Enter the last stop you knocked, so the next person knows where to start.'; return; }
    const btn = form.querySelector('#fSave');
    btn.disabled = true;
    try { await bringBack(r, f); after(); } catch (x) { form.querySelector('#fErr').textContent = friendly(x); btn.disabled = false; }
  });
  setTimeout(() => form.querySelector('#fKnocked')?.focus(), 0);
}

// ------------------------------------------------------------------ board
function closeOverlay() { $('overlay').hidden = true; $('overlay').innerHTML = ''; }
$('overlay').addEventListener('click', e => { if (e.target === $('overlay')) closeOverlay(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('overlay').hidden) closeOverlay(); });
function statusCell(r) {
  const d = deskOf(r.id), last = (d.history || []).filter(h => !h.released).at(-1);
  if (d.status === 'out') return `<span class="pill out">Out</span><span class="who">${esc(d.name)} · since ${clock(d.outAt)} (${since(d.outAt)})</span>`;
  if (d.status === 'done') return `<span class="pill done">Done</span><span class="who">${esc(last?.name || d.name)} · ${last?.knocked ?? 0} knocked${last?.rides ? ` · ${last.rides} ride${last.rides > 1 ? 's' : ''}` : ''}</span>`;
  if (d.resumeAt > 1) return `<span class="pill part">Partly done</span><span class="who">Resume at stop ${d.resumeAt}${last ? ` · last ${esc(last.name)}` : ''}</span>`;
  return '<span class="pill open">Free</span>';
}
function renderBoard() {
  const b = $('boardBody');
  if (!S.ready) { b.innerHTML = '<div class="empty"><h2>Connecting…</h2><p class="note">Reading the shared board.</p></div>'; return; }
  const total = S.routes.length, done = S.routes.filter(r => isDone(r.id)).length, out = S.routes.filter(r => isOut(r.id)).length;
  const hist = S.routes.flatMap(r => (deskOf(r.id).history || []).filter(h => !h.released).map(h => ({ ...h, id: r.id })));
  const sum = k => hist.reduce((t, h) => t + (h[k] || 0), 0), doorsTotal = S.routes.reduce((t, r) => t + r.doors, 0);
  const pct = n => total ? (n / total) * 100 : 0;
  let h = '';
  if (total) {
    h += `<div class="stats">
      <div class="stat"><b>${done}<span class="num" style="font-size:18px;color:var(--muted)"> / ${total}</span></b><span>routes done</span>
        <div class="bar" aria-hidden="true"><i style="width:${pct(done)}%;background:var(--green)"></i><i style="width:${pct(out)}%;background:var(--blue)"></i></div></div>
      <div class="stat"><b>${out}</b><span>volunteers out now</span></div>
      <div class="stat"><b>${sum('knocked').toLocaleString('en-CA')}</b><span>doors knocked of ${doorsTotal.toLocaleString('en-CA')}</span></div>
      <div class="stat"><b>${sum('home').toLocaleString('en-CA')}</b><span>people home</span></div>
      <div class="stat"><b>${sum('rides')}</b><span>rides needed</span></div>
    </div>`;
    const ps = pollStates();
    h += `<section><div class="section-head"><h2>Polls</h2>
        <label class="switch"><input type="checkbox" id="onePerPoll" ${S.settings.onePerPoll ? 'checked' : ''}> One volunteer per poll at a time</label></div>
      <div class="legend"><span><i style="background:var(--card)"></i>Free</span><span><i style="background:var(--blue-soft);border-color:var(--blue)"></i>Someone out</span>
        <span><i style="background:var(--gold-soft);border-color:var(--gold)"></i>Partly done</span><span><i style="background:var(--green-soft);border-color:var(--green)"></i>Done</span></div>
      <div class="polls" style="margin-top:10px">${ps.map(p => `<div class="pchip ${p.state}"><b>${esc(p.poll)}</b><span>${p.state === 'out' ? esc(p.names.join(', ')) : p.state === 'done' ? 'Done' : p.state === 'part' ? 'Partly done' : `${p.rs.length} route${p.rs.length > 1 ? 's' : ''}`}</span></div>`).join('')}</div></section>`;
    let lastArea = null;
    h += `<section><div class="section-head"><h2>Routes</h2><p class="note">Handed out in this order: the party’s priority groups first, then other polls by focus rank.</p></div>
      <div class="table-wrap"><table><thead><tr><th>Route</th><th>Polls</th><th>Doors</th><th>Time</th><th>Status</th><th></th></tr></thead><tbody>${S.routes.map(r => {
        const band = r.area !== lastArea ? (lastArea = r.area, `<tr class="group"><td colspan="6">${esc(where(r))}</td></tr>`) : '';
        const d = deskOf(r.id), acts = d.status === 'out'
          ? `<button class="btn small" data-board="back" data-id="${esc(r.id)}">Hand in</button> <button class="btn small quiet" data-board="release" data-id="${esc(r.id)}">Release</button>`
          : (d.status === 'done' ? `<button class="btn small quiet" data-board="reopen" data-id="${esc(r.id)}">Reopen</button>`
          : `<button class="btn small" data-board="assign" data-id="${esc(r.id)}">Give to…</button>`)
            + ` <button class="btn small quiet" data-board="remove" data-id="${esc(r.id)}" title="Take this route off the board">Remove</button>`;
        return `${band}<tr><td class="code">${esc(r.id)}</td><td>${esc(r.polls.join(', '))}</td><td class="num">${r.doors}</td><td class="num">${hm(r.minutes)}</td><td>${statusCell(r)}</td><td class="acts">${acts}</td></tr>`;
      }).join('')}</tbody></table></div></section>`;
    const events = hist.map(e => ({ t: e.backAt, text: `${esc(e.name)} handed in ${esc(e.id)}: ${e.knocked} knocked${e.rides ? `, ${e.rides} ride${e.rides > 1 ? 's' : ''}` : ''}${e.finished ? '' : `, stopped at stop ${e.stoppedAt}`}${e.note ? ` (“${esc(e.note)}”)` : ''}` }))
      .concat(S.routes.filter(r => isOut(r.id)).map(r => ({ t: deskOf(r.id).outAt, text: `${esc(deskOf(r.id).name)} took ${esc(r.id)}` })))
      .filter(e => e.t).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 14);
    if (events.length) h += `<section><div class="section-head"><h2>Latest</h2></div><ul class="log">${events.map(e => `<li><time>${clock(e.t)}</time><span>${e.text}</span></li>`).join('')}</ul></section>`;
  } else {
    h += `<div class="empty"><h2>No route book yet</h2><p class="note">On the <a href="${MAP_URL}">Poll map</a>, open the Routes tab and choose “Build the route book”, then “Copy for the check-in desk”, and paste it below.</p></div>`;
  }
  if (S.canAdmin) h += `<details class="admin" ${total ? '' : 'open'}><summary>Load a route book</summary>
      <p class="note">Paste the text from the Poll map (Routes tab, “Copy for the check-in desk”). Routes keep their status when the codes match, and removed routes come back; routes that are out stay on the board until they’re handed in.
      Print the matching packets from the same route book.</p>
      <textarea id="bookPaste" aria-label="Route book text"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" type="button" id="bookLoad">Load route book</button><span class="note" id="bookMsg">${esc(S.bookMsg || '')}</span></div>
      ${S.meta ? `<p class="note" style="margin-top:8px">Loaded now: built ${esc(S.meta.built)} from the Poll Summary of ${esc(S.meta.pollSummary || 'unknown date')}, ${S.meta.count} routes of up to ${S.meta.perRoute} doors${S.meta.maxWalkKm ? ` and ${S.meta.maxWalkKm} km` : ''}, knocking ${esc(S.meta.knock)}.</p>` : ''}
    </details>`;
  h += `<p class="note">Every laptop that opens this page shares this board, and changes show up on the others within a second or two.</p>`;
  b.innerHTML = h;
}
$('boardBody').addEventListener('change', async e => {
  if (e.target.id !== 'onePerPoll') return;
  const on = e.target.checked;
  try { await store.write(st => { st.settings = { ...st.settings, onePerPoll: on }; }, `One volunteer per poll: ${on ? 'on' : 'off'}`); } catch (x) { banner(friendly(x)); e.target.checked = !on; }
});
$('boardBody').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'bookLoad') return loadBook();
  const r = S.routes.find(x => x.id === b.dataset.id);
  if (!r) return;
  if (b.dataset.board === 'back') { $('overlay').innerHTML = returnForm(r, 'board'); $('overlay').hidden = false; wireReturn($('overlay'), r, closeOverlay); return; }
  if (b.dataset.board === 'assign') {
    $('overlay').innerHTML = `<form class="form" id="giveForm"><h3>Give ${esc(r.id)} to…</h3><p class="note">${esc(where(r))} · ${esc(pollsText(r))} · ${r.doors} doors</p>
      <label class="field">Volunteer’s name<input id="gName" required maxlength="60" autocomplete="off"></label><p class="err" id="gErr" role="alert"></p>
      <div class="row"><button class="btn go" type="submit">Give route</button><button class="btn quiet" type="button" data-cancel>Cancel</button></div></form>`;
    $('overlay').hidden = false;
    const form = $('giveForm');
    form.querySelector('[data-cancel]').addEventListener('click', closeOverlay);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const name = tidy($('gName').value), has = routeOutFor(name);
      if (has) { $('gErr').textContent = `${name} already has ${has.id} out. Hand that one in first.`; return; }
      try { (await giveRoute(name, r)) ? closeOverlay() : ($('gErr').textContent = 'Someone else just took this route.'); } catch (x) { $('gErr').textContent = friendly(x); }
    });
    setTimeout(() => $('gName').focus(), 0);
    return;
  }
  b.disabled = true;
  if (b.dataset.board === 'remove') {
    const was = isDone(r.id) ? ' Its handed-in counts leave the totals too.' : '';
    if (!confirm(`Remove route ${r.id} from the board? Volunteers won’t be given it.${was} Loading the route book again brings it back.`)) return;
    b.disabled = true;
    try { if (!(await removeRoute(r))) banner(`${r.id} wasn’t removed: someone has just taken it out. Hand it in or release it first.`); } catch (x) { banner(friendly(x)); b.disabled = false; }
    return;
  }
  try { if (b.dataset.board === 'release') await release(r); if (b.dataset.board === 'reopen') await reopen(r); } catch (x) { banner(friendly(x)); b.disabled = false; }
});
async function loadBook() {
  const msg = { set textContent(t) { S.bookMsg = t; const el = $('bookMsg'); if (el) el.textContent = t; } };
  let book;
  try { book = JSON.parse($('bookPaste').value); } catch (x) { msg.textContent = 'That isn’t the route book text. Copy it again from the Poll map.'; return; }
  if (book?.kind !== 'route-book' || !Array.isArray(book.routes) || !book.routes.length) { msg.textContent = 'That isn’t the route book text. Copy it again from the Poll map.'; return; }
  const ok = r => typeof r.id === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(r.id) && Array.isArray(r.polls) && Number.isFinite(r.doors);
  if (!book.routes.every(ok)) { msg.textContent = 'Some routes in that text are damaged. Copy it again from the Poll map.'; return; }
  const btn = $('bookLoad');
  btn.disabled = true;
  try {
    const clean = book.routes.map(r => ({ id: r.id, order: +r.order || 0, area: String(r.area || ''), place: String(r.place || ''), polls: r.polls.map(String),
      doors: +r.doors, people: +r.people || 0, km: +r.km || 0, minutes: +r.minutes || 0, streets: (r.streets || []).map(String).slice(0, 40) }));
    await store.write(st => {
      const ids = new Set(clean.map(r => r.id));
      // routes that are out stay on the board until they're handed in, even if the new book drops them
      st.routes = clean.concat(st.routes.filter(r => !ids.has(r.id) && st.desk[r.id]?.status === 'out'));
      st.meta = { built: String(book.built || ''), pollSummary: String(book.pollSummary || ''), knock: String(book.knock || ''),
        perRoute: +book.perRoute || 0, maxWalkKm: +book.maxWalkKm || 0, count: clean.length };
    }, `Loaded a route book: ${clean.length} routes`);
    msg.textContent = `Loaded ${book.routes.length} routes.`;
    if ($('bookPaste')) $('bookPaste').value = '';
  } catch (x) { msg.textContent = friendly(x); }
  if ($('bookLoad')) $('bookLoad').disabled = false;
}

// ------------------------------------------------------------------ shell
function banner(text) { $('banner').textContent = text || ''; }
function selectTab(name) {
  S.view = name;
  for (const t of ['checkin', 'board']) {
    const btn = $('tab-' + t), on = t === name;
    btn.setAttribute('aria-selected', on);
    btn.tabIndex = on ? 0 : -1;
    $(t).hidden = !on;
  }
  render();
}
document.querySelector('.tabs').addEventListener('click', e => { const t = e.target.closest('[role="tab"]'); if (t) selectTab(t.id.slice(4)); });
document.querySelector('.tabs').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const next = S.view === 'checkin' ? 'board' : 'checkin';
  selectTab(next);
  $('tab-' + next).focus();
});
function render() {
  // keep a half-typed name or an open form intact when other people's changes arrive
  const typing = document.activeElement && ['vName', 'bookPaste'].includes(document.activeElement.id);
  if (S.view === 'checkin') { if (!(typing && S.flow.step === 'ask') && S.flow.step !== 'return') renderKiosk(); }
  else if (!(typing || document.activeElement?.closest?.('#boardBody details[open] textarea'))) renderBoard();
}
setInterval(() => { if (S.view === 'board' && $('overlay').hidden) render(); }, 30000);  // keep "out for" times current
// a kiosk left on a ticket goes back to the name screen after two minutes
let idle = 0;
addEventListener('pointerdown', () => { idle = 0; });
addEventListener('keydown', () => { idle = 0; });
setInterval(() => { if (++idle >= 4 && S.view === 'checkin' && ['assigned', 'already', 'thanks', 'none'].includes(S.flow.step)) setFlow({ step: 'ask' }); }, 30000);

// ------------------------------------------------------------------ connecting a device, and keeping up with the others
function apply(st) {
  S.routes = [...st.routes].sort((a, b) => a.order - b.order);
  S.desk = new Map(Object.entries(st.desk || {}));
  S.settings = { onePerPoll: st.settings?.onePerPoll !== false };
  S.meta = st.meta;
  render();
}
store.listeners.push(apply);
// The plain link is all a laptop needs: the database is named in desk-config.js, which ships with the site.
async function start() {
  history.replaceState(null, '', location.pathname + location.search);  // old desk links carried a key after '#'; drop it
  try { localStorage.removeItem('scc-desk-connection'); } catch (x) { /* storage blocked */ }
  const cfg = window.DESK_DB;
  if (!cfg || !cfg.databaseURL || typeof firebase === 'undefined') { banner('The desk isn’t switched on yet: its shared database hasn’t been set up.'); return; }
  banner('Connecting to the desk…');
  let gone = 0;
  store.onLine = up => {
    clearTimeout(gone);
    if (up) { if (S.ready) banner(''); }
    else if (S.ready) gone = setTimeout(() => banner('This laptop has lost the internet connection. The board may be out of date, and changes can’t be saved until it’s back.'), 4000);
  };
  try { await store.connect(cfg); }
  catch (x) { banner(friendly(x)); return; }
  S.ready = true;
  banner('');
  apply(store.state);
}
renderKiosk();
start();
