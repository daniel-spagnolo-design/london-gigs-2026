# London Revisited 2026

Finds artists from my Spotify **Liked Songs** who are playing **London in August 2026**,
and turns the results into a clean, single-page site.

It cross-references four gig sources and matches them against my liked artists:

- **Ticketmaster** Discovery API — structured lineups (confirmed)
- **Resident Advisor** (ra.co internal GraphQL) — structured lineups (confirmed)
- **DICE** (api.dice.fm internal endpoint) — structured lineups (confirmed)
- **Skiddle** API — free-text title matching (verify)

Results are merged, de-duplicated per artist+date, written to
`london_gigs_August2026.txt`, and rendered into `index.html` by `build.mjs`.

## Setup

This repo is public, so secrets and personal data are **not** committed. To run it
yourself you need to supply two things locally:

1. **API keys** — copy the template and fill in your own keys:
   ```sh
   cp keys_local.example.py keys_local.py   # then edit keys_local.py
   ```
   (`keys_local.py` is git-ignored.)

2. **Your liked songs** — export your Spotify Liked Songs to `Liked_Songs.csv`
   (also git-ignored) with an `Artist Name(s)` column.

## Run

```sh
python3 london_gigs_checker.py   # fetch + match -> london_gigs_August2026.txt
node build.mjs                   # render        -> index.html
```

A weekly `launchd` job (`com.daniel.londongigs`) re-runs the checker every Monday
and retires itself after 31 Aug 2026.

## View / refresh from your phone (no laptop)

The page is a static file, so GitHub Pages can host it and you can open it in any
mobile browser. A GitHub Actions workflow lets you re-fetch gigs remotely.

**One-time setup (on your machine + GitHub UI):**

1. Push this folder to a **public** GitHub repo (`.gitignore` already keeps
   `keys_local.py`, `Liked_Songs.csv` and `liked_artists.txt` out — check
   `git status` shows none of them staged).
2. Set the repo slug in `build.mjs` — edit the `REPO` constant to
   `your-username/london-gigs-2026`, then re-run `node build.mjs` and commit, so
   the page's **Refresh gigs** button points at your repo.
3. **Settings → Pages → Source: Deploy from a branch → `main` / root.** After a
   minute the URL appears: `https://<your-username>.github.io/london-gigs-2026/`.
   That's the link you open on your phone.
4. **Settings → Secrets and variables → Actions** → add three secrets:
   - `TM_API_KEY` and `SKIDDLE_API_KEY` — your keys from `keys_local.py`.
   - `LIKED_ARTISTS` — your artist names, one per line. Generate the exact text with:
     ```sh
     python3 -c "import csv;a=set();[a.update(x.strip() for x in r['Artist Name(s)'].split(';')) for r in csv.DictReader(open('Liked_Songs.csv',encoding='utf-8-sig'))];a.discard('');print('\n'.join(sorted(a)))"
     ```

**Refreshing while away:** open the Pages URL → tap **Refresh gigs** (or go to the
repo's **Actions → Refresh gigs → Run workflow**). The workflow re-fetches gigs,
rebuilds `index.html`, and commits it; Pages redeploys automatically, so reloading
the page shows the update. A scheduled run also refreshes weekly through August.

The full `Liked_Songs.csv` and your API keys never leave your machine — only the
compact artist-name list lives in the `LIKED_ARTISTS` secret.
