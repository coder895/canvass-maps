# Handoff: Surrey-Guildford data

Where this repo stands, and the steps left to turn it into the Surrey-Guildford campaign map.

## Where it stands

- **Base map: done.** `data/public.js` is Surrey-Guildford (SRG), built by `tools/build_public.py SRG` from Elections BC, the BC Digital Road Atlas and the BC Address Geocoder: 63 voting areas plus 4 site-based (064S–067S), 37,612 registered voters, 11 election-day voting places, 23,142 address points. The 2024 result matches Elections BC: NDP 8,947, Conservative 8,925 (22 votes). The same script rebuilds Surrey City Centre identically to the old file (outline, polls, registered voters, results), with better address coverage.
- **Titles: done.** `index.html`, `polls.html` and `desk.html` say Surrey-Guildford.
- **Reading the Full exports: done.** Both maps recognise them (`sniff()` → `'full'`, `parseFull()`, `fromFull()` and `residentList()` in `core.js`), load them in the browser and from the built-in data, and the poll map's "Save for the team" carries them. Tested end to end with synthetic files in the same 24-column format: password screen, supporters by house and poll, 2024 lists, focus ranking, routes, the Voted tab matching a participation report by voter number, and house popups listing who lives there.
- **Sealing tool: done.** `tools/seal.js` writes `data/campaign.enc.js` (PBKDF2-SHA256, 600,000 iterations; gzip then AES-256-GCM) and `--check` opens it again.
- **Checked against the real exports (2026-10-16):** 3,486 of the 3,488 current supporters and 1,569 of the 1,570 on the 2024 list are placed inside the riding (the one address not found is on 74B St, which isn't in Surrey-Guildford); every poll number 001–063 matches the map.
- **Both files say who voted in 2024.** The 2026 file has "Has Voted 2024" too, including for the 1,938 supporters who aren't on the 2024 list (1,038 voted, 900 didn't). So "didn't vote in 2024" (the GOTV lists, focus scores and routes) comes from both files: 1,372 supporters, not just the 472 on the 2024 list. "2024 supporters" still counts the 1,570 on the 2024 list. The 1,550 people in both files agree on their 2024 vote.
- **Built in (2026-10-16):** `data/campaign.enc.js` holds both exports, locked with the team password, so both maps open on this election's supporters by poll (the campaign map shades the polls by "Supporters found"; the poll map by "Supporters now", with a "Didn't vote in 2024" colouring too). The password is in `~/Desktop/canvass-data/TEAM-PASSWORD.txt` on Harry's Mac, outside the repo: share it with the team directly, never in GitHub.
- **Published:** GitHub Pages serves this build at https://coder895.github.io/canvass-maps/ (deploys from `main`, root). With no data built in, it opens without a password, and anyone on the team can load the two Full exports in their own browser; the files never leave the device.

## The data

Two "Full" supporter exports from the campaign database (one sheet each, same 24 columns):

| File | People | What it is |
|---|---|---|
| `Full-2024-10-15-4.xlsx` | 1,570 | The 2024 supporter list. All have a Voter ID. Has Voted 2024: 1,098 yes, 472 no |
| `Full-2026-10-15-5.xlsx` | 3,488 | Supporters identified this election (2026). 3,441 have a Voter ID |

Only these columns are kept, in the encrypted file and in the file saved for the team: `ID, First Name, Last Name, Support, Addr 1, Poll, Has Voted 2024, Voter ID, Support Updated, Home Tel, Cell Tel`.

**Never commit these spreadsheets.** The repo is public. Only the encrypted `data/campaign.enc.js` goes in. `.gitignore` keeps out `.xlsx` and `.csv` files.

## Steps left

1. ~~Check against the real files.~~ Done (above).
2. ~~Seal them~~ Done. To load a newer export later: `CAMPAIGN_PASSWORD='…' node tools/seal.js Full-2024-10-15-4.xlsx Full-2026-10-15-5.xlsx`, then `node tools/seal.js --check`. Use a strong generated password and share it with the team outside GitHub.
3. **Voter ID:** once the first Elections BC participation report arrives, load it and check that our supporters match (the Voted tab's "of our supporters have voted"). If almost none match, `Voter ID` isn't the report's card number.
4. ~~Publish the sealed data~~ Done. After sealing a newer export, commit `data/campaign.enc.js` and push to `main`; Pages redeploys on its own.

### Optional: check-in desk and sign-in log

- Create a Firebase Realtime Database and put its URL in `desk-config.js`.
- Add the same URL to `connect-src` in the Content-Security-Policy at the top of `index.html` and `polls.html`.
- Publish `database.rules.json` under Realtime Database → Rules.
