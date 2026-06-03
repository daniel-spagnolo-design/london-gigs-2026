#!/usr/bin/env node
// Generates index.html from london_gigs_August2026.txt
// Run: node build.mjs
//
// Visual system follows docs/design.md (Wise-style: lime CTA, sage canvas, ink text,
// 24px pill radius, weight-900 display). Personality per docs/PRODUCT.md: bold &
// energetic within that palette — big type, a dark hero, one loud lime accent.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(ROOT, "london_gigs_August2026.txt");
const OUT = join(ROOT, "index.html");
// Committed snapshot of the gig keys from the previous build, used to count how
// many gigs are new since the last refresh (drives the dismissable banner).
const STATE = join(ROOT, "gigs_seen.json");
// Tiny file the page polls (cache-busted) to detect a newer deploy and reload
// itself — needed because the iOS home-screen app caches the HTML hard. Holds
// this build's "Last updated" stamp; see the auto-update script in renderPage.
const VERSION = join(ROOT, "version.json");

// "owner/repo" on GitHub — used to deep-link the page's "Refresh gigs" button
// to the manual-trigger page of the refresh-gigs workflow. Set this to your repo.
const REPO = "daniel-spagnolo-design/london-gigs-2026";
const REFRESH_URL = `https://github.com/${REPO}/actions/workflows/refresh-gigs.yml`;
// Val.town endpoint that dispatches refresh-gigs.yml — it holds the GitHub token
// server-side so the static page never exposes it. The "Refresh gigs" button
// POSTs here. Leave empty to keep the button inert (page still works); see the
// click-handler script in renderPage.
const REFRESH_PROXY_URL = "https://dspag--f320650c5eec11f1a2951607ee4eb77e.web.val.run";

// ---------- parse ----------

function parseFeed(text) {
  const lines = text.split(/\r?\n/);

  // "Last updated" is written by the checker as YYYY-MM-DD HH:MM in UTC (it runs
  // on a UTC server). Capture it as an explicit UTC instant (…Z) so the browser
  // can re-render it in the viewer's own timezone. See the inline script.
  const updatedLine = lines.find((l) => /^Last updated:/i.test(l)) || "";
  const um = updatedLine.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  const updatedIso = um
    ? `${um[1]}-${um[2]}-${um[3]}T${um[4]}:${um[5]}:00Z`
    : new Date().toISOString();

  // Everything after the === rule is gig blocks separated by --- dividers.
  const body = text.split(/^=+\s*$/m).pop() || text;
  const blocks = body
    .split(/^-{3,}\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  const gigs = [];
  for (const block of blocks) {
    const blockLines = block.split(/\r?\n/).map((l) => l.trim());
    const dt = blockLines[0]?.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})/);
    if (!dt) continue; // not a gig block

    const fields = {};
    for (const line of blockLines.slice(1)) {
      const m = line.match(/^(\w+)\s*:\s*(.+)$/);
      if (m) fields[m[1].toLowerCase()] = m[2].trim();
    }

    const [, y, mo, d, time] = dt;
    gigs.push({
      date: `${y}-${mo}-${d}`,
      time,
      sortKey: `${y}-${mo}-${d}T${time}`,
      artist: fields.artist || "Unknown artist",
      event: fields.event || "",
      venue: fields.venue || "",
      source: fields.source || "",
      tickets: fields.tickets || "",
    });
  }

  gigs.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return { gigs, updatedIso };
}

// ---------- format ----------

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });

function dateParts(dateStr, time) {
  const dObj = new Date(`${dateStr}T${time}:00Z`);
  return {
    weekday: WEEKDAY.format(dObj), // Sat
    day: dateStr.slice(8, 10).replace(/^0/, ""), // 22
    month: MONTH.format(dObj), // Aug
  };
}

function timeLabel(time) {
  const [h, m] = time.split(":");
  const hr = Number(h);
  const suffix = hr < 12 ? "am" : "pm";
  const h12 = hr % 12 === 0 ? 12 : hr % 12;
  return m === "00" ? `${h12}${suffix}` : `${h12}:${m}${suffix}`;
}

const esc = (s = "") =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

const ordinal = (n) => {
  const v = n % 100;
  return ["th", "st", "nd", "rd"][(v - 20) % 10] || ["th", "st", "nd", "rd"][v] || "th";
};

// Server-rendered fallback for "Last updated", e.g. "Tuesday Jun 2nd 2026, 4:15pm".
// Rendered in UTC; the inline script re-renders it in the viewer's timezone.
function formatUpdatedUTC(iso) {
  const d = new Date(iso);
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const month = d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  const hr = d.getUTCHours();
  const min = d.getUTCMinutes();
  const suffix = hr < 12 ? "am" : "pm";
  const h12 = hr % 12 === 0 ? 12 : hr % 12;
  const time = min === 0 ? `${h12}${suffix}` : `${h12}:${String(min).padStart(2, "0")}${suffix}`;
  return `${weekday} ${month} ${day}${ordinal(day)} ${d.getUTCFullYear()}, ${time}`;
}

// ---------- render ----------

function renderRow(g) {
  const { weekday, day, month } = dateParts(g.date, g.time);
  const ticketBtn = g.tickets
    ? `<a class="tickets" href="${esc(g.tickets)}" target="_blank" rel="noopener"
           aria-label="Buy tickets for ${esc(g.artist)}">Tickets <span aria-hidden="true">&rsaquo;</span></a>`
    : `<span class="tickets tickets--none">No link</span>`;

  return `      <li class="gig">
        <div class="gig__date" aria-hidden="true">
          <span class="gig__day">${esc(day)}</span>
          <span class="gig__mon">${esc(month)}</span>
        </div>
        <div class="gig__info">
          <h3 class="gig__artist">${esc(g.artist)}</h3>
          <p class="gig__event">${esc(g.event)}</p>
          <p class="gig__meta">
            <span class="gig__when">${esc(weekday)} ${esc(day)} ${esc(month)} &middot; ${esc(timeLabel(g.time))}</span>
            <span class="gig__dot" aria-hidden="true">&middot;</span>
            <span class="gig__venue">${esc(g.venue)}</span>
          </p>
        </div>
        ${ticketBtn}
      </li>`;
}

function renderPage({ gigs, updatedIso, newCount = 0 }) {
  const count = gigs.length;
  const rows = gigs.map(renderRow).join("\n");
  const year = new Date().getUTCFullYear();
  const updatedFallback = formatUpdatedUTC(updatedIso);

  // Refresh banner: how many gigs are new since the last refresh (or none).
  // `data-build` ties a dismissal to this specific build so a later refresh
  // (new timestamp) shows the banner again. See the inline script below.
  const bannerMsg =
    newCount > 0
      ? `${newCount} new gig${newCount === 1 ? "" : "s"} found since your last refresh`
      : "No new gigs since your last refresh";
  const banner = `      <div class="banner banner--${newCount > 0 ? "new" : "none"}" id="refresh-banner"
           role="status" data-build="${updatedIso}">
        <span class="banner__msg">${bannerMsg}</span>
        <button class="banner__close" type="button" aria-label="Dismiss this message">&times;</button>
      </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>London Revisited 2026 — August gigs</title>
  <meta name="description" content="Artists from my Spotify Liked Songs playing London in August 2026." />
  <meta name="color-scheme" content="light" />
  <link rel="apple-touch-icon" href="apple-touch-icon.png" />
  <link rel="icon" href="apple-touch-icon.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="London Gigs" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Manrope:wght@600;700;800&display=swap" />
  <style>
    :root {
      /* docs/design.md tokens */
      --primary: #9fe870;
      --primary-active: #cdffad;
      --primary-pale: #e2f6d5;
      --canvas: #ffffff;
      --canvas-soft: #e8ebe6;
      --ink: #0e0f0c;
      --ink-deep: #163300;
      --body: #454745;
      --mute: #868685;
      --r-md: 12px;
      --r-lg: 16px;
      --r-xl: 24px;
      --r-pill: 9999px;
      --display: "Manrope", "Inter", system-ui, sans-serif;
      --sans: "Inter", system-ui, -apple-system, sans-serif;
      --container: 1100px;
    }

    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      background: var(--canvas-soft);
      color: var(--ink);
      font-family: var(--sans);
      font-size: 16px;
      line-height: 1.5;
      font-feature-settings: "calt";
      -webkit-font-smoothing: antialiased;
    }
    a { color: inherit; }

    .wrap {
      max-width: var(--container);
      margin: 0 auto;
      padding: 24px 24px 0;
    }

    /* ---------- hero (dark, polarity-flipped per docs/design.md hero-band-dark) ---------- */
    .hero {
      background: var(--ink);
      color: var(--canvas);
      border-radius: var(--r-xl);
      padding: clamp(32px, 6vw, 72px);
      margin-top: 24px;
      position: relative;
      overflow: hidden;
    }
    .hero__badge {
      display: inline-block;
      background: var(--primary);
      color: var(--ink);
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.01em;
      padding: 6px 14px;
      border-radius: var(--r-pill);
      margin-bottom: clamp(20px, 4vw, 36px);
    }
    .hero__title {
      font-family: var(--display);
      font-weight: 800;
      line-height: 0.92;
      letter-spacing: -0.02em;
      margin: 0;
    }
    .hero__title .l1 {
      display: block;
      color: var(--primary);
      font-size: clamp(56px, 13vw, 132px);
      text-transform: uppercase;
    }
    .hero__title .l2 {
      display: block;
      color: var(--canvas);
      font-size: clamp(24px, 5.5vw, 56px);
      font-weight: 700;
      letter-spacing: -0.01em;
      margin-top: 0.1em;
    }
    .hero__sub {
      margin: clamp(20px, 4vw, 32px) 0 0;
      max-width: 46ch;
      color: #d7dad4;
      font-size: clamp(16px, 2.2vw, 20px);
      line-height: 1.45;
    }
    /* quiet secondary action on the dark hero — deep-links to the GitHub
       Actions "Run workflow" page to re-fetch gigs (see build.mjs REPO). */
    .hero__refresh {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: clamp(24px, 4vw, 32px);
      padding: 11px 20px;
      border: 1.5px solid rgba(255, 255, 255, 0.35);
      border-radius: var(--r-pill);
      background: transparent;
      cursor: pointer;
      color: var(--canvas);
      font: inherit;
      font-weight: 600;
      font-size: 15px;
      text-decoration: none;
      transition: border-color 0.15s ease, background 0.15s ease, opacity 0.15s ease, transform 160ms ease-out;
    }
    /* Press feedback — but not while searching (the button has morphed by then). */
    .hero__refresh:not(.is-loading):active { transform: scale(0.97); }
    .hero__refresh:hover {
      border-color: var(--primary);
      background: rgba(159, 232, 112, 0.12);
    }
    .hero__refresh:focus-visible {
      outline: 3px solid var(--primary);
      outline-offset: 2px;
    }
    .hero__refresh:disabled { opacity: 0.6; cursor: default; }
    .hero__chevron { color: var(--primary); }
    /* Spinning green ring shown only while searching. */
    .hero__spinner {
      display: none;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: 2.5px solid rgba(159, 232, 112, 0.25);
      border-top-color: var(--primary);
    }
    @keyframes hero-spin { to { transform: rotate(360deg); } }
    @keyframes hero-fade-in { from { opacity: 0; } to { opacity: 1; } }
    /* Loading state: morph the pill into just the spinner + "Searching…" copy. */
    .hero__refresh.is-loading {
      border-color: transparent;
      background: transparent;
      cursor: default;
      padding-left: 0;
    }
    .hero__refresh.is-loading:hover { background: transparent; }
    .hero__refresh.is-loading .hero__chevron { display: none; }
    /* Faster spin (feels faster) + a one-shot fade so it doesn't pop in. The
       fade animates opacity only, so it won't fight the rotate transform. */
    .hero__refresh.is-loading .hero__spinner {
      display: inline-block;
      animation: hero-spin 0.7s linear infinite, hero-fade-in 220ms ease-out;
    }
    /* Reduced motion: drop the rotation, keep an opacity pulse as the cue. */
    @media (prefers-reduced-motion: reduce) {
      .hero__refresh.is-loading .hero__spinner {
        animation: hero-pulse 1.2s ease-in-out infinite;
      }
      @keyframes hero-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    }
    .hero__fallback {
      display: block;
      margin-top: 12px;
      color: var(--canvas);
      font-family: var(--sans);
      font-size: 13px;
      opacity: 0.75;
      text-decoration: underline;
    }
    .hero__fallback[hidden] { display: none; }

    /* ---------- refresh banner ---------- */
    .banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin: 0 0 4px;
      padding: 14px 18px;
      border-radius: var(--r-lg);
      font-size: 15px;
      font-weight: 700;
      box-shadow: 0 10px 24px -20px rgba(14, 15, 12, 0.6);
    }
    .banner--new {
      background: var(--primary);
      color: var(--ink);
    }
    .banner--none {
      background: var(--canvas);
      color: var(--ink);
      border: 1.5px solid #c5ccc0;
      border-left: 5px solid var(--ink-deep);
    }
    .banner__msg {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    /* status dot so the bar clearly reads as a banner at a glance */
    .banner__msg::before {
      content: "";
      flex-shrink: 0;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--ink);
    }
    .banner--none .banner__msg::before { background: var(--ink-deep); }
    .banner__close {
      flex-shrink: 0;
      appearance: none;
      border: 0;
      background: transparent;
      color: inherit;
      font-size: 22px;
      line-height: 1;
      padding: 4px 9px;
      margin: -4px -8px -4px 0;
      border-radius: var(--r-md);
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.15s ease, background 0.15s ease;
    }
    .banner__close:hover { opacity: 1; background: rgba(0, 0, 0, 0.08); }
    .banner__close:focus-visible {
      outline: 3px solid var(--ink);
      outline-offset: 2px;
      opacity: 1;
    }

    /* ---------- section heading ---------- */
    .section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      margin: clamp(40px, 7vw, 64px) 0 20px;
    }
    .section-head h2 {
      font-family: var(--display);
      font-weight: 800;
      font-size: clamp(28px, 5vw, 44px);
      letter-spacing: -0.02em;
      line-height: 1;
      margin: 0;
    }
    .section-head .caption {
      color: var(--body);
      font-size: 14px;
      margin: 0;
    }

    /* ---------- gig list ---------- */
    .gigs {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .gig {
      background: var(--canvas);
      border-radius: var(--r-xl);
      padding: 20px 24px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 24px;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .gig:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 28px -18px rgba(14, 15, 12, 0.5);
    }

    .gig__date {
      width: 64px;
      flex-shrink: 0;
      text-align: center;
      font-family: var(--display);
      line-height: 1;
    }
    .gig__day {
      display: block;
      font-size: 38px;
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .gig__mon {
      display: block;
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ink-deep);
      margin-top: 2px;
    }

    .gig__info { min-width: 0; }
    .gig__event, .gig__meta { overflow-wrap: anywhere; }
    .gig__artist {
      font-family: var(--display);
      font-size: clamp(20px, 3vw, 26px);
      font-weight: 800;
      letter-spacing: -0.01em;
      line-height: 1.1;
      margin: 0;
    }
    .gig__event {
      margin: 4px 0 0;
      color: var(--body);
      font-size: 15px;
    }
    .gig__meta {
      margin: 8px 0 0;
      color: var(--body);
      font-size: 14px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .gig__when { font-weight: 600; color: var(--body); }
    .gig__dot { color: var(--mute); }

    /* ---------- tickets button (button-primary) ---------- */
    .tickets {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--primary);
      color: var(--ink);
      font-family: var(--sans);
      font-weight: 600;
      font-size: 16px;
      text-decoration: none;
      padding: 12px 22px;
      border-radius: var(--r-xl);
      transition: background 0.15s ease;
      white-space: nowrap;
    }
    .tickets:hover { background: var(--primary-active); }
    .tickets span { font-size: 20px; line-height: 1; }
    .tickets:focus-visible {
      outline: 3px solid var(--ink);
      outline-offset: 2px;
    }
    .tickets--none {
      background: var(--canvas-soft);
      color: var(--mute);
      cursor: default;
    }

    /* ---------- footer ---------- */
    footer {
      background: var(--ink);
      color: var(--canvas-soft);
      margin-top: clamp(48px, 8vw, 80px);
      padding: 48px 24px;
    }
    footer .wrap-inner {
      max-width: var(--container);
      margin: 0 auto;
      font-size: 14px;
      line-height: 1.6;
    }
    footer strong { color: var(--primary); font-weight: 700; }
    footer .muted { color: #8a8d86; }

    /* ---------- responsive ---------- */
    @media (max-width: 640px) {
      .gig {
        grid-template-columns: auto minmax(0, 1fr);
        grid-template-areas:
          "date info"
          "btn  btn";
        gap: 16px 18px;
      }
      .gig__date { grid-area: date; width: 52px; }
      .gig__day { font-size: 30px; }
      .gig__info { grid-area: info; }
      .tickets {
        grid-area: btn;
        justify-content: center;
        width: 100%;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; }
      .gig:hover { transform: none; }
    }
  </style>
</head>
<body>
  <main class="wrap">
${banner}
    <header class="hero">
      <span class="hero__badge">Aug 2026 &middot; ${count} gig${count === 1 ? "" : "s"}</span>
      <h1 class="hero__title">
        <span class="l1">London</span>
        <span class="l2">revisited 2026</span>
      </h1>
      <p class="hero__sub">Artists from my Spotify Liked Songs playing London this August. Tap through to grab a ticket.</p>
      <!-- Fires refresh-gigs.yml in the background via the Val.town proxy (see
           REFRESH_PROXY_URL and the click-handler script below). The fallback
           link to the Actions page is revealed only if the trigger fails. -->
      <button type="button" class="hero__refresh" id="refresh-btn">
        <span class="hero__spinner" aria-hidden="true"></span>
        <span class="refresh-label" aria-live="polite">Refresh gigs</span>
        <span class="hero__chevron" aria-hidden="true">&rsaquo;</span>
      </button>
      <a class="hero__fallback" id="refresh-fallback" hidden
         href="${REFRESH_URL}" target="_blank" rel="noopener">Open Actions manually</a>
    </header>

    <section aria-labelledby="gigs-heading">
      <div class="section-head">
        <h2 id="gigs-heading">Aug 2026 gigs</h2>
        <p class="caption">Last updated <time id="updated-time" datetime="${updatedIso}">${esc(updatedFallback)}</time> &middot; ${count} match${count === 1 ? "" : "es"}</p>
      </div>
      <ul class="gigs">
${rows}
      </ul>
    </section>
  </main>

  <footer>
    <div class="wrap-inner">
      <p><strong>London Revisited 2026</strong></p>
      <p class="muted">Sources: Ticketmaster + Resident Advisor + DICE. Built from
      london_gigs_August2026.txt &middot; &copy; ${year}</p>
    </div>
  </footer>

  <script>
    // Re-render "Last updated" in the viewer's own timezone. The page is built
    // on a UTC server, so the embedded <time> is UTC; here we localise it to
    // wherever the reader is (home now, London in August) and match their clock.
    (function () {
      var el = document.getElementById("updated-time");
      if (!el) return;
      var d = new Date(el.getAttribute("datetime"));
      if (isNaN(d.getTime())) return;
      var weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
      var month = d.toLocaleDateString("en-GB", { month: "short" });
      var day = d.getDate();
      var v = day % 100, s = ["th", "st", "nd", "rd"];
      var ord = s[(v - 20) % 10] || s[v] || "th";
      var hr = d.getHours(), min = d.getMinutes();
      var suffix = hr < 12 ? "am" : "pm", h12 = hr % 12 === 0 ? 12 : hr % 12;
      var time = min === 0 ? h12 + suffix : h12 + ":" + String(min).padStart(2, "0") + suffix;
      el.textContent = weekday + " " + month + " " + day + ord + " " + d.getFullYear() + ", " + time;
    })();
  </script>

  <script>
    // Dismiss the refresh banner. The dismissal is remembered per build (keyed
    // on the "Last updated" stamp), so a later refresh shows a fresh banner.
    (function () {
      var b = document.getElementById("refresh-banner");
      if (!b) return;
      var key = "lr2026-banner-dismissed:" + (b.dataset.build || "");
      try {
        if (localStorage.getItem(key)) { b.remove(); return; }
      } catch (e) {}
      b.querySelector(".banner__close").addEventListener("click", function () {
        try { localStorage.setItem(key, "1"); } catch (e) {}
        b.remove();
      });
    })();
  </script>

  <script>
    // Auto-update for the iOS home-screen app. Standalone web apps cache the
    // HTML aggressively and often won't pick up a new deploy. This build's
    // version is baked in below; we compare it against version.json — fetched
    // fresh (cache-busted) on open and whenever the app returns to the
    // foreground — and if the deployed build is newer we reload to a
    // cache-busting URL so the new HTML actually loads (no stale-cache loop).
    (function () {
      var BUILD = "${updatedIso}";
      function check() {
        fetch("version.json?t=" + Date.now(), { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (v) {
            if (!v || !v.version || v.version === BUILD) return;
            location.replace(location.pathname + "?v=" + encodeURIComponent(v.version));
          })
          .catch(function () {});
      }
      check();
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") check();
      });
    })();
  </script>

  <script>
    // "Refresh gigs" button. POSTs to the Val.town proxy (which holds the GitHub
    // token and dispatches refresh-gigs.yml), shows inline status, then polls
    // version.json — same build-stamp the auto-updater uses — so the page reloads
    // itself once the workflow has committed the new gigs (~1-3 min later).
    (function () {
      var PROXY = "${REFRESH_PROXY_URL}";
      var BUILD = "${updatedIso}";
      var btn = document.getElementById("refresh-btn");
      var fallback = document.getElementById("refresh-fallback");
      if (!btn) return;
      var label = btn.querySelector(".refresh-label");
      function setLabel(t) { if (label) label.textContent = t; }
      // No proxy configured yet: keep the button inert rather than erroring.
      if (!PROXY || PROXY.indexOf("PASTE_YOUR_VAL_URL") === 0) {
        btn.disabled = true;
        return;
      }

      var busy = false, deadline = 0;
      function startLoading() {
        busy = true;
        btn.classList.add("is-loading");
        btn.setAttribute("aria-busy", "true");
        if (fallback) fallback.hidden = true;
        setLabel("Searching (may take 30 seconds)");
      }
      function stopLoading() {
        busy = false;
        btn.classList.remove("is-loading");
        btn.removeAttribute("aria-busy");
      }

      function poll() {
        fetch("version.json?t=" + Date.now(), { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (v) {
            if (v && v.version && v.version !== BUILD) {
              location.replace(location.pathname + "?v=" + encodeURIComponent(v.version));
              return;
            }
            if (Date.now() < deadline) { setTimeout(poll, 15000); return; }
            stopLoading();
            setLabel("Still working — check back soon");
          })
          .catch(function () {
            if (Date.now() < deadline) setTimeout(poll, 15000);
          });
      }

      function fail() {
        stopLoading();
        setLabel("Couldn't start — tap to retry");
        if (fallback) fallback.hidden = false;
      }

      btn.addEventListener("click", function () {
        if (busy) return;
        startLoading();
        // Keep the spinner + "Searching…" copy running through both the dispatch
        // and the version.json poll, until the new gigs land and we reload.
        fetch(PROXY, { method: "POST" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (d && d.ok) {
              deadline = Date.now() + 4 * 60 * 1000;
              setTimeout(poll, 15000);
            } else {
              fail();
            }
          })
          .catch(fail);
      });
    })();
  </script>
</body>
</html>
`;
}

// ---------- new-gig diff ----------

// Compare this build's gigs against the previous build's (gigs_seen.json) and
// return how many are new, then persist the current set for next time. A gig is
// keyed by date+artist, matching the de-dupe key used by the checker. On the
// first build (no state file) nothing is "new" — we just record the baseline.
function countNewGigs(gigs) {
  const keys = gigs.map((g) => `${g.date}|${g.artist.toLowerCase()}`).sort();

  let prev = [];
  try {
    prev = JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    prev = [];
  }
  const firstRun = !Array.isArray(prev) || prev.length === 0;
  const prevSet = new Set(prev);
  const newCount = firstRun ? 0 : keys.filter((k) => !prevSet.has(k)).length;

  writeFileSync(STATE, JSON.stringify(keys) + "\n", "utf8");
  return newCount;
}

// ---------- main ----------

const text = readFileSync(SOURCE, "utf8");
const data = parseFeed(text);
data.newCount = countNewGigs(data.gigs);
writeFileSync(OUT, renderPage(data), "utf8");
writeFileSync(VERSION, JSON.stringify({ version: data.updatedIso }) + "\n", "utf8");
console.log(`Wrote ${OUT} — ${data.gigs.length} gigs (${data.newCount} new).`);
for (const g of data.gigs) console.log(`  ${g.date} ${g.time}  ${g.artist}`);
