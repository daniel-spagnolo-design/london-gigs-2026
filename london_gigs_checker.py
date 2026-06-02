"""
London Gigs Checker
-------------------
Finds live-music events in London (August 2026) that match artists from your
Spotify Liked Songs CSV. Cross-references three sources, all with structured
artist lineups ("confirmed" matches):

  * Ticketmaster Discovery API — structured performer data
  * Resident Advisor (ra.co internal GraphQL) — structured lineups
  * DICE (api.dice.fm internal endpoint) — structured lineups

Results from all sources are merged and de-duplicated (same artist + same date).

Usage:
    python3 london_gigs_checker.py

Requirements:
    pip install requests
"""

import csv
import os
import re
import time
import subprocess
import requests
from pathlib import Path
from datetime import datetime, date

# ── Config ────────────────────────────────────────────────────────────────────
# API keys live in keys_local.py (git-ignored) so they never reach the public
# repo. Copy keys_local.example.py -> keys_local.py and fill in your keys.
try:
    from keys_local import TM_API_KEY
except ImportError as exc:
    raise SystemExit(
        "Missing keys_local.py — run `cp keys_local.example.py keys_local.py` "
        "and add your Ticketmaster API key."
    ) from exc

CSV_PATH        = Path(__file__).parent / "Liked_Songs.csv"
# Fallback artist source for environments without the (git-ignored) CSV — e.g.
# CI, where a small newline-separated list of artist names is supplied instead
# of the full personal Liked_Songs.csv. See load_liked_artists().
ARTISTS_TXT     = Path(__file__).parent / "liked_artists.txt"
OUTPUT_PATH     = Path(__file__).parent / "london_gigs_August2026.txt"
# Run logs live in logs/ (git-ignored). Ensure the folder exists so appends
# don't fail on a fresh checkout.
LOG_PATH        = Path(__file__).parent / "logs" / "run_log.txt"
LOG_PATH.parent.mkdir(exist_ok=True)

START_DATE      = "2026-08-01T00:00:00Z"
END_DATE        = "2026-08-31T23:59:59Z"
WINDOW_MIN      = "2026-08-01"   # shared date window for the RA + DICE fetchers
WINDOW_MAX      = "2026-08-31"

# London centre; used by the DICE fetcher's geo search
LONDON_LAT      = 51.5074
LONDON_LON      = -0.1278

# Resident Advisor + DICE have no public API, so we call the same internal
# endpoints their own websites use. Both expose exact, structured artist
# lineups, so matching mirrors the high-precision Ticketmaster path. These are
# undocumented and may change without notice.
USER_AGENT      = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
RA_AREA_LONDON  = 13     # ra.co area id for London
RA_PAGE_SIZE    = 20
DICE_TAGS       = ["music:gig", "music:dj", "music:party"]

PAGE_SIZE       = 200    # Ticketmaster
RATE_LIMIT_S    = 0.25

# DICE's title pre-filter matches against free-text titles, so guard against
# false positives: skip artist names shorter than this, plus common words that
# double as names.
MIN_FUZZY_LEN   = 4
STOPWORD_NAMES  = {
    "yes", "war", "girl", "girls", "boy", "boys", "mess", "air", "hot", "cream",
    "the", "live", "love", "free", "fire", "rush", "wire", "kiss", "bush",
    "queen", "blur", "muse", "cake", "ash", "beck", "pink", "low", "spoon",
    "garbage", "texas", "london", "sound", "house", "soul", "disco", "jazz",
    "funk", "club", "party", "band", "music", "show", "tour", "feat", "dj",
}

CUTOFF_DATE     = date(2026, 8, 31)   # after this, the weekly job retires itself
LAUNCHD_LABEL   = "com.daniel.londongigs"
# ─────────────────────────────────────────────────────────────────────────────


def retire_schedule() -> None:
    """Past CUTOFF_DATE there's nothing left to find, so unload and delete the
    weekly launchd job. Deleting the plist first means it won't reload on the
    next login even if bootout kills this process mid-call."""
    plist = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"
    try:
        if plist.exists():
            plist.unlink()
    except OSError:
        pass
    # launchctl only exists on macOS — on Linux (e.g. CI runners) there's no
    # launchd job to retire, so a missing binary is a no-op rather than an error.
    try:
        subprocess.run(
            ["launchctl", "bootout", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"],
            capture_output=True,
        )
    except (FileNotFoundError, AttributeError):
        pass


def load_artists_csv(csv_path: Path) -> set[str]:
    artists = set()
    with open(csv_path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            for a in row["Artist Name(s)"].split(";"):
                artists.add(a.strip().lower())
    artists.discard("")
    return artists


def load_artists_txt(txt_path: Path) -> set[str]:
    """Load a plain newline-separated list of artist names (one per line). This
    is the compact, less-personal source used in CI: the full Liked_Songs.csv
    reduces to exactly this set of names, so matching is identical either way."""
    with open(txt_path, encoding="utf-8-sig") as f:
        artists = {line.strip().lower() for line in f}
    artists.discard("")
    return artists


def load_liked_artists() -> set[str]:
    """Prefer the full Liked_Songs.csv when present (local runs); otherwise fall
    back to liked_artists.txt (CI). Both yield a set of lowercased artist names."""
    if CSV_PATH.exists():
        return load_artists_csv(CSV_PATH)
    if ARTISTS_TXT.exists():
        return load_artists_txt(ARTISTS_TXT)
    raise SystemExit(
        f"No artist source found — provide {CSV_PATH.name} (export of your Spotify "
        f"Liked Songs) or {ARTISTS_TXT.name} (newline-separated artist names)."
    )


# ── Ticketmaster ────────────────────────────────────────────────────────────
def fetch_ticketmaster(api_key: str) -> list[dict]:
    base = "https://app.ticketmaster.com/discovery/v2/events.json"
    params = {
        "apikey":             api_key,
        "classificationName": "music",
        "city":               "London",
        "countryCode":        "GB",
        "startDateTime":      START_DATE,
        "endDateTime":        END_DATE,
        "size":               PAGE_SIZE,
        "page":               0,
        "sort":               "date,asc",
    }

    all_events = []
    while True:
        r = requests.get(base, params=params, timeout=15)
        r.raise_for_status()
        data = r.json()

        page_info    = data.get("page", {})
        total_pages  = page_info.get("totalPages", 1)
        current_page = page_info.get("number", 0)
        events       = data.get("_embedded", {}).get("events", [])
        all_events.extend(events)

        print(f"  [TM]      Page {current_page + 1}/{total_pages}  ({len(events)} events)")

        if current_page + 1 >= total_pages:
            break
        params["page"] += 1
        time.sleep(RATE_LIMIT_S)

    return all_events


def match_ticketmaster(events: list[dict], liked_artists: set[str]) -> list[dict]:
    """Match on structured attractions (performers) — high confidence."""
    matches = []
    for event in events:
        d        = event.get("dates", {}).get("start", {}).get("localDate", "")
        time_str = event.get("dates", {}).get("start", {}).get("localTime", "") or ""
        venues   = event.get("_embedded", {}).get("venues", [{}])
        venue    = venues[0].get("name", "") if venues else ""
        url      = event.get("url", "")
        ev_name  = event.get("name", "")

        for attr in event.get("_embedded", {}).get("attractions", []):
            attr_name = attr.get("name", "")
            if attr_name.lower() in liked_artists:
                matches.append({
                    "artist":     attr_name,
                    "event":      ev_name,
                    "date":       d,
                    "time":       time_str[:5] if time_str else "",
                    "venue":      venue,
                    "url":        url,
                    "source":     "Ticketmaster",
                    "confidence": "confirmed",
                })
    return matches


# ── Fuzzy title matcher (used by the DICE pre-filter) ─────────────────────────
def _alternation_regex(names: list[str]):
    if not names:
        return None
    # longest-first so "the national" wins over a shorter substring
    alt = "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))
    return re.compile(rf"\b({alt})\b", re.IGNORECASE)


def build_fuzzy_matcher(liked_artists: set[str]):
    """Compile word-boundary regexes over the 'safe' artist names. Two scopes:

      * title_regex  — all safe names, scanned against the event TITLE
      * desc_regex   — only MULTI-WORD names, scanned against the description

    Single-word names (e.g. 'prince', 'banks') are kept out of the description
    scan because lone common words match incidental prose constantly. Returns
    (title_regex, desc_regex, lookup) where lookup maps lowercased -> canonical."""
    safe, multiword = [], []
    for name in liked_artists:
        if len(name) < MIN_FUZZY_LEN or name in STOPWORD_NAMES:
            continue
        safe.append(name)
        if " " in name:
            multiword.append(name)
    lookup = {n: n for n in safe}
    return _alternation_regex(safe), _alternation_regex(multiword), lookup


# ── Resident Advisor (ra.co GraphQL) ──────────────────────────────────────────
RA_QUERY = (
    "query GET_EVENT_LISTINGS($filters: FilterInputDtoInput, "
    "$filterOptions: FilterOptionsInputDtoInput, $page: Int, $pageSize: Int) { "
    "eventListings(filters: $filters, filterOptions: $filterOptions, "
    "pageSize: $pageSize, page: $page) { data { event { title date startTime "
    "contentUrl venue { name } artists { name } } } totalResults } }"
)


def fetch_resident_advisor() -> list[dict]:
    """Query the same internal GraphQL endpoint ra.co's own site uses. Returns
    structured events (lineup, venue, date) for London in the date window."""
    url     = "https://ra.co/graphql"
    headers = {
        "Content-Type":    "application/json",
        "ra-content-type": "application/json",
        "User-Agent":      USER_AGENT,
        "Referer":         "https://ra.co/events/uk/london",
    }
    all_events = []
    page = 1
    while True:
        payload = {
            "operationName": "GET_EVENT_LISTINGS",
            "variables": {
                "filters": {
                    "areas":       {"eq": RA_AREA_LONDON},
                    "listingDate": {"gte": WINDOW_MIN, "lte": WINDOW_MAX},
                },
                "filterOptions": {"genre": True, "eventType": True},
                "pageSize": RA_PAGE_SIZE,
                "page":     page,
            },
            "query": RA_QUERY,
        }
        r = requests.post(url, json=payload, headers=headers, timeout=20)
        r.raise_for_status()
        body = r.json()
        if body.get("errors"):
            raise RuntimeError(f"RA GraphQL error: {body['errors']}")

        listing = body.get("data", {}).get("eventListings", {})
        total   = listing.get("totalResults", 0)
        chunk   = [row.get("event", {}) for row in listing.get("data", [])]
        all_events.extend(chunk)
        print(f"  [RA]      Page {page}  ({len(chunk)} events, {len(all_events)}/{total})")

        if not chunk or len(all_events) >= total:
            break
        page += 1
        time.sleep(RATE_LIMIT_S)
    return all_events


def match_resident_advisor(events: list[dict], liked_artists: set[str]) -> list[dict]:
    """Exact-match the structured lineup against liked artists — high confidence."""
    matches = []
    for event in events:
        start = event.get("startTime") or ""
        d     = (event.get("date") or "")[:10]
        t     = start[11:16] if len(start) >= 16 else ""
        venue = (event.get("venue") or {}).get("name", "")
        url   = "https://ra.co" + (event.get("contentUrl") or "")
        title = event.get("title", "")

        for artist in event.get("artists", []):
            name = artist.get("name", "")
            if name.lower() in liked_artists:
                matches.append({
                    "artist":     name,
                    "event":      title,
                    "date":       d,
                    "time":       t,
                    "venue":      venue,
                    "url":        url,
                    "source":     "Resident Advisor",
                    "confidence": "confirmed",
                })
    return matches


# ── DICE (api.dice.fm) ─────────────────────────────────────────────────────────
def fetch_dice() -> list[dict]:
    """Enumerate London events in the date window via DICE's internal search
    endpoint (the one their web app uses). The browse feed carries no lineup,
    only id/name/date/venue — lineups are confirmed later via the detail call."""
    url     = "https://api.dice.fm/unified_search"
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    by_id: dict[str, dict] = {}

    for tag in DICE_TAGS:
        cursor = None
        page   = 0
        while True:
            payload = {
                "tag":   tag,
                "lat":   LONDON_LAT,
                "lng":   LONDON_LON,
                "dates": {"from": WINDOW_MIN, "to": WINDOW_MAX},
            }
            if cursor:
                payload["cursor"] = cursor
            r = requests.post(url, json=payload, headers=headers, timeout=20)
            r.raise_for_status()
            data = r.json()

            new = 0
            for section in data.get("sections", []):
                for item in section.get("items", []) or []:
                    if item.get("type") != "event":
                        continue
                    ev  = item.get("event", {})
                    eid = ev.get("id")
                    if not eid or eid in by_id:
                        continue
                    start  = (ev.get("dates", {}) or {}).get("event_start_date", "")
                    if not start.startswith("2026-08"):
                        continue   # date filter is fuzzy at the edges; pin to August
                    venues = ev.get("venues") or [{}]
                    by_id[eid] = {
                        "id":    eid,
                        "name":  ev.get("name", ""),
                        "date":  start[:10],
                        "time":  start[11:16] if len(start) >= 16 else "",
                        "venue": venues[0].get("name", "") if venues else "",
                    }
                    new += 1

            cursor = data.get("next_page_cursor")
            page  += 1
            print(f"  [DICE]    {tag}  page {page}  (+{new}, {len(by_id)} unique)")
            if new == 0 or not cursor or page >= 40:
                break
            time.sleep(RATE_LIMIT_S)
    return list(by_id.values())


def _fetch_dice_detail(event_id: str) -> dict:
    r = requests.get(f"https://api.dice.fm/events/{event_id}",
                     headers={"User-Agent": USER_AGENT}, timeout=20)
    r.raise_for_status()
    return r.json()


def match_dice(events: list[dict], liked_artists: set[str]) -> list[dict]:
    """Two-stage match: cheaply narrow the enumerated events by liked-artist
    names appearing in the title, then confirm each candidate against the
    structured lineup from the detail endpoint (so the result is 'confirmed')."""
    title_regex, _desc_regex, lookup = build_fuzzy_matcher(liked_artists)
    if title_regex is None:
        return []

    matches = []
    for ev in events:
        # Stage 1 — title pre-filter avoids a detail fetch for every event.
        if not title_regex.search(ev["name"]):
            continue

        # Stage 2 — confirm via the structured lineup.
        detail   = _fetch_dice_detail(ev["id"])
        time.sleep(RATE_LIMIT_S)
        lineup   = (detail.get("summary_lineup") or {}).get("top_artists", []) or []
        perm     = detail.get("perm_name", "")
        url      = f"https://dice.fm/event/{perm}" if perm else ""

        for artist in lineup:
            name = artist.get("name", "")
            if name.lower() in liked_artists:
                matches.append({
                    "artist":     name,
                    "event":      ev["name"],
                    "date":       ev["date"],
                    "time":       ev["time"],
                    "venue":      ev["venue"],
                    "url":        url,
                    "source":     "DICE",
                    "confidence": "confirmed",
                })
    return matches


# ── Merge / output ────────────────────────────────────────────────────────────
def merge_dedupe(*match_lists: list[dict]) -> list[dict]:
    """One entry per (artist, date) across all sources (first match wins)."""
    best: dict[tuple, dict] = {}
    for m in [x for lst in match_lists for x in lst]:
        key = (m["artist"].lower(), m["date"])
        if key not in best:
            best[key] = m
    out = list(best.values())
    out.sort(key=lambda x: (x["date"], x["artist"].lower()))
    return out


def write_results(matches: list[dict], output_path: Path) -> None:
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("LONDON GIGS — AUGUST 2026\n")
        f.write("Artists from your Spotify Liked Songs playing in London\n")
        f.write("Sources: Ticketmaster + Resident Advisor + DICE (confirmed)\n")
        f.write(f"Last updated: {datetime.now():%Y-%m-%d %H:%M}  "
                f"({len(matches)} matches)\n")
        f.write("=" * 60 + "\n\n")

        if not matches:
            f.write("No matches found.\n")
            return

        for m in matches:
            f.write(f"{m['date']}  {m['time']}\n")
            f.write(f"Artist : {m['artist']}\n")
            f.write(f"Event  : {m['event']}\n")
            f.write(f"Venue  : {m['venue']}\n")
            f.write(f"Source : {m['source']}\n")
            f.write(f"Tickets: {m['url']}\n")
            f.write("-" * 60 + "\n")

    print(f"\nResults saved to: {output_path}")


def main():
    if date.today() > CUTOFF_DATE:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now():%Y-%m-%d %H:%M}  past cutoff — retiring weekly job, no update\n")
        retire_schedule()
        return

    print("Loading liked artists...")
    liked_artists = load_liked_artists()
    print(f"  {len(liked_artists)} unique artists loaded\n")

    print("Fetching Ticketmaster (Aug 2026)...")
    tm_events = fetch_ticketmaster(TM_API_KEY)
    print(f"  Ticketmaster events: {len(tm_events)}\n")

    print("Fetching Resident Advisor (Aug 2026)...")
    ra_events = fetch_resident_advisor()
    print(f"  Resident Advisor events: {len(ra_events)}\n")

    # DICE uses an undocumented internal endpoint that can change without notice.
    # Per the "strict" choice: on any failure, surface it loudly and log it, but
    # still build the page from the other sources (TM + RA) rather than crashing.
    print("Fetching DICE (Aug 2026)...")
    dice_events: list[dict] = []
    dice_failed = False
    try:
        dice_events = fetch_dice()
        print(f"  DICE events: {len(dice_events)}\n")
    except Exception as exc:
        dice_failed = True
        print("\n" + "!" * 60)
        print("⚠️  DICE FETCH FAILED — the other sources will still be used.")
        print(f"    {type(exc).__name__}: {exc}")
        print("    DICE's internal endpoint/shape likely changed — needs a look.")
        print("!" * 60 + "\n")

    print("Cross-referencing with liked artists...")
    tm_matches = match_ticketmaster(tm_events, liked_artists)
    ra_matches = match_resident_advisor(ra_events, liked_artists)
    dice_matches: list[dict] = []
    if not dice_failed:
        try:
            dice_matches = match_dice(dice_events, liked_artists)
        except Exception as exc:
            dice_failed = True
            print("\n" + "!" * 60)
            print("⚠️  DICE MATCHING FAILED — the other sources will still be used.")
            print(f"    {type(exc).__name__}: {exc}")
            print("!" * 60 + "\n")
    matches = merge_dedupe(tm_matches, ra_matches, dice_matches)

    print(f"  Matches: {len(matches)}\n")

    if matches:
        print("─" * 60)
        for m in matches:
            print(f"  {m['date']} {m['time']:5}  {m['artist']}")
            print(f"               {m['venue']}  ({m['source']})")
            print(f"               {m['url']}")
            print()
    else:
        print("  No matches found.")

    write_results(matches, OUTPUT_PATH)

    total_events = len(tm_events) + len(ra_events) + len(dice_events)
    dice_note = "DICE FAILED" if dice_failed else f"DICE {len(dice_events)}"
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        status = "ran with DICE failure" if dice_failed else "ran OK"
        f.write(f"{datetime.now():%Y-%m-%d %H:%M}  {status} — {total_events} events scanned "
                f"(TM {len(tm_events)} + RA {len(ra_events)} + "
                f"{dice_note}), {len(matches)} matches\n")


if __name__ == "__main__":
    main()
