# Handoff: Surrey-Guildford data

Where this repo stands, and the steps left to turn it into the Surrey-Guildford campaign map.

## Where it stands

- **Base map: done.** `data/public.js` is Surrey-Guildford (SRG), built by `tools/build_public.py SRG` from Elections BC, the BC Digital Road Atlas and the BC Address Geocoder: 63 voting areas plus 4 site-based (064S–067S), 37,612 registered voters, 11 election-day voting places, 23,142 address points. The 2024 result matches Elections BC: NDP 8,947, Conservative 8,925 (22 votes). The same script rebuilds Surrey City Centre identically to the old file (outline, polls, registered voters, results), with better address coverage.
- **Titles: done.** `index.html`, `polls.html` and `desk.html` say Surrey-Guildford.
- **Reading the Full exports: done.** Both maps recognise them (`sniff()` → `'full'`, `parseFull()`, `fromFull()` and `residentList()` in `core.js`), load them in the browser and from the built-in data, and the poll map's "Save for the team" carries them. Tested end to end with synthetic files in the same 24-column format: password screen, supporters by house and poll, 2024 lists, focus ranking, routes, the Voted tab matching a participation report by voter number, and house popups listing who lives there.
- **Sealing tool: done.** `tools/seal.js` writes `data/campaign.enc.js` (PBKDF2-SHA256, 600,000 iterations; gzip then AES-256-GCM) and `--check` opens it again.
- `data/campaign.enc.js` is still the empty stub: the real exports haven't been sealed yet.
- GitHub Pages is on (main, root) and still serves the old Surrey City Centre build until the next push.

## The data

Two "Full" supporter exports from the campaign database (one sheet each, same 24 columns):

| File | People | What it is |
|---|---|---|
| `Full-2024-10-15-4.xlsx` | 1,570 | The 2024 supporter list. All have a Voter ID. Has Voted 2024: 1,098 yes, 472 no |
| `Full-2026-10-15-5.xlsx` | 3,488 | Supporters identified this election (2026). 3,441 have a Voter ID |

Only these columns are kept, in the encrypted file and in the file saved for the team: `ID, First Name, Last Name, Support, Addr 1, Poll, Has Voted 2024, Voter ID, Support Updated, Home Tel, Cell Tel`.

**Never commit these spreadsheets.** The repo is public. Only the encrypted `data/campaign.enc.js` goes in. `.gitignore` keeps out `.xlsx` and `.csv` files.

## Steps left

1. **Check against the real files.** Load both into `index.html` (served locally, e.g. `python3 -m http.server`) and check: the address check in Households (how many placed, outside, not found), that polls 1–63 line up with the map, and that `Addr 1` parses for every row. The synthetic test can't show how the real addresses and phone numbers are written.
2. **Seal them:** `CAMPAIGN_PASSWORD='…' node tools/seal.js Full-2024-10-15-4.xlsx Full-2026-10-15-5.xlsx`, then `node tools/seal.js --check`. Use a strong generated password and share it with the team outside GitHub.
3. **Voter ID:** once the first Elections BC participation report arrives, load it and check that our supporters match (the Voted tab's "of our supporters have voted"). If almost none match, `Voter ID` isn't the report's card number.
4. **Publish:** commit and push to `main`; Pages redeploys on its own.

### Optional: check-in desk and sign-in log

- Create a Firebase Realtime Database and put its URL in `desk-config.js`.
- Add the same URL to `connect-src` in the Content-Security-Policy at the top of `index.html` and `polls.html`.
- Publish `database.rules.json` under Realtime Database → Rules.
