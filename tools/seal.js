#!/usr/bin/env node
'use strict';
// Locks the campaign's two Full supporter exports into data/campaign.enc.js with the team password, the way core.js opens it:
// a key from the password by PBKDF2-SHA256 (600,000 iterations), and the payload gzipped JSON encrypted with AES-256-GCM, all base64.
//
//   CAMPAIGN_PASSWORD='…' node tools/seal.js ~/canvass-data/Full-2024-10-15-4.xlsx ~/canvass-data/Full-2026-10-15-5.xlsx
//   CAMPAIGN_PASSWORD='…' node tools/seal.js --check       opens data/campaign.enc.js and says what's in it
//   --password-file <file> reads the password from a file instead.
//
// Keep the spreadsheets outside the repository and never commit them: only the encrypted file goes in. Only the columns the maps
// read are kept (FULL_KEEP in core.js). Sealing again with the same password keeps the salt, so data/campaign.extra.enc.js and
// browsers already unlocked keep working; a new password makes a new salt, and campaign.extra.enc.js has to be saved again.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const XLSX = require('../vendor/xlsx.full.min.js');

const OUT = path.join(__dirname, '..', 'data', 'campaign.enc.js');
const ITERATIONS = 600000;
const FULL_NEED = ['ID', 'First Name', 'Last Name', 'Support', 'Addr 1', 'Poll', 'Has Voted 2024', 'Voter ID'];
const FULL_KEEP = [...FULL_NEED, 'Support Updated', 'Home Tel', 'Cell Tel'];

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const pwFile = flag('--password-file'), check = args.includes('--check');
const password = pwFile ? fs.readFileSync(pwFile, 'utf8').trim() : process.env.CAMPAIGN_PASSWORD;
if (!password) { console.error('Give the team password in CAMPAIGN_PASSWORD or with --password-file.'); process.exit(1); }

const cell = v => v == null ? '' : String(v).trim();
const keyFor = salt => crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
function current() {  // the box in data/campaign.enc.js, if there is one
  try {
    const window = {};
    new Function('window', fs.readFileSync(OUT, 'utf8'))(window);
    return window.CAMPAIGN_ENC || null;
  } catch (e) { return null; }
}
function open(box) {
  const raw = Buffer.from(box.data, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', keyFor(Buffer.from(box.salt, 'base64')), Buffer.from(box.iv, 'base64'));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()])));
}
function describe(payload) {
  for (const f of payload.full || []) {
    const [H, ...rows] = f.rows, voted = H.indexOf('Has Voted 2024');
    console.log(`  ${f.name}: ${rows.length} people, columns ${H.join(', ')}; voted in 2024: ${rows.filter(r => /^(y|true$|1$)/i.test(cell(r[voted]))).length} yes, ${rows.filter(r => /^(n|false$|0$)/i.test(cell(r[voted]))).length} no`);
  }
}

if (check) {
  const box = current();
  if (!box) { console.error(`${OUT} has no encrypted data in it.`); process.exit(1); }
  try { const p = open(box); console.log(`Opened ${OUT} (sealed ${p.built || 'on an unknown date'}):`); describe(p); }
  catch (e) { console.error('That password doesn’t open it.'); process.exit(1); }
  process.exit(0);
}

if (!args.length) { console.error('Name the Full export files to lock.'); process.exit(1); }
const full = args.map(file => {
  const ws = XLSX.read(fs.readFileSync(file), { type: 'buffer' }).Sheets, rows = XLSX.utils.sheet_to_json(ws[Object.keys(ws)[0]], { header: 1, raw: true, defval: null, blankrows: false });
  const head = rows.findIndex(r => r && FULL_NEED.every(h => r.some(v => cell(v) === h)));
  if (head < 0) { console.error(`${file} isn’t a Full export: it has no ${FULL_NEED.join(', ')} header row.`); process.exit(1); }
  const H = rows[head].map(cell), keep = FULL_KEEP.filter(n => H.includes(n)), id = H.indexOf('ID');
  return { name: path.basename(file), rows: [keep, ...rows.slice(head + 1).filter(r => r && cell(r[id])).map(r => keep.map(n => r[H.indexOf(n)] ?? null))] };
});
const years = full.map(f => +((/(?:^|\D)(20\d\d)(?=\D|$)/.exec(f.name) || [])[1] || 0));
if (!years.some(y => y && y <= 2024) || !years.some(y => y > 2024)) console.warn('Warning: the maps tell the 2024 list from the current one by the year in the file name, and these names don’t give one of each.');

const payload = { v: 1, built: new Date().toISOString().slice(0, 10), full };
const was = current();
let salt = crypto.randomBytes(16);
if (was?.salt) { try { open(was); salt = Buffer.from(was.salt, 'base64'); } catch (e) { console.log('A new password: making a new salt. Save campaign.extra.enc.js again if there is one.'); } }
const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyFor(salt), iv);
const data = Buffer.concat([c.update(zlib.gzipSync(JSON.stringify(payload))), c.final(), c.getAuthTag()]);
const box = { v: 1, salt: salt.toString('base64'), iterations: ITERATIONS, iv: iv.toString('base64'), data: data.toString('base64') };
fs.writeFileSync(OUT, `// The campaign's data, locked with the team password (AES-256-GCM; key from PBKDF2-SHA256). Made by tools/seal.js on ${payload.built}.\n`
  + `window.CAMPAIGN_ENC = ${JSON.stringify(box)};\n`);
console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB):`);
describe(open(box));
