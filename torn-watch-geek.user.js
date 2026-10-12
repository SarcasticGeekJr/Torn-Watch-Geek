// ==UserScript==
// @name         Torn Watch Geek
// @namespace    https://github.com/SarcasticGeekJr/torn-watch-geek
// @version      1.4.1
// @description  Watch players (online, hospital, jail, flight landing times, bazaar and Item Market listings) and find mug targets: rich sellers, sleeping workers in high-paying companies, and your own advanced search, all with estimated battle stats and win chance. Built for Torn PDA, works in Tampermonkey too.
// @author       SarcasticGeekJr
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      ffscouter.com
// @connect      www.tornstats.com
// @connect      weav3r.dev
// @connect      raw.githubusercontent.com
// @run-at       document-end
// @homepageURL  https://github.com/SarcasticGeekJr/torn-watch-geek
// @supportURL   https://github.com/SarcasticGeekJr/torn-watch-geek/issues
// @updateURL    https://raw.githubusercontent.com/SarcasticGeekJr/torn-watch-geek/main/torn-watch-geek.user.js
// @downloadURL  https://raw.githubusercontent.com/SarcasticGeekJr/torn-watch-geek/main/torn-watch-geek.user.js
// ==/UserScript==

/*
 * Data sources
 *   - Official Torn API (a Public key is enough; Torn PDA fills it in automatically):
 *       v1 /user/{id}?selections=profile        status, last action, level, job, faction
 *       v1 /user/{id}?selections=bazaar         a watched player's bazaar
 *       v1 /user/?selections=battlestats        your own stats (only if your key allows it, optional)
 *       v1 /company/{type}?selections=companies all companies of one type (stars, income)
 *       v1 /company/{id}?selections=profile     one company and its employees
 *       v1 /torn/?selections=companies          company type names
 *       v2 /torn/hof?cat=...                    Hall of Fame pages, 100 players each
 *       v2 /faction/{id}/members                faction members, up to 100 per call
 *       v2 /market/bazaar                       this week's top-earning bazaars
 *   - FF Scouter (ffscouter.com): estimated battle stats and Fair Fight. Uses the same Torn key,
 *     which must be registered once at ffscouter.com.
 *   - Torn Stats (optional, own key): spy reports when your faction has one.
 *   - TornW3B (weav3r.dev): public bazaar listings, used to spot bazaar sales.
 *   - Item Market pages you open: seller names and listings are read from the page you are looking at.
 *
 * Rules: this script only reads data and shows it. Profile, Attack and Bazaar buttons only open
 * the page. It never attacks, buys, sells or clicks anything in the game for you.
 */

(function () {
  "use strict";

  if (window.__tornWatchGeekLoaded) return;
  window.__tornWatchGeekLoaded = true;

  // ---------------------------------------------------------------- config
  const PDA_KEY = "###PDA-APIKEY###"; // Torn PDA replaces this with your key at runtime
  const VERSION = "1.4.1"; // keep in sync with @version above
  const UPDATE_URL = "https://raw.githubusercontent.com/SarcasticGeekJr/torn-watch-geek/main/torn-watch-geek.user.js";
  const TORN = "https://api.torn.com";
  const FFS = "https://ffscouter.com/api/v1/get-stats";
  const TS = "https://www.tornstats.com/api/v2";
  const W3B = "https://weav3r.dev/api/marketplace";
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const PROFILE_TTL = 10 * MIN; // profile data for Hunt results
  const COMPANY_TTL = 6 * HOUR;
  const STATS_TTL = 12 * HOUR;
  const DB_MAX = 9000; // players kept in the local search list
  const EVENTS_MAX = 300;

  // Flight times in minutes, one way: [Standard, Airstrip, WLT/Private, Business].
  // Same table Torn PDA uses (Torn wiki, after patch #438). Real flights vary by about 3%.
  const FLIGHT = {
    Mexico: [24, 17, 12, 7],
    "Cayman Islands": [33, 23, 17, 10],
    Canada: [39, 27, 19, 12],
    Hawaii: [127, 89, 63, 38],
    "United Kingdom": [151, 106, 75, 45],
    Argentina: [158, 111, 79, 47],
    Switzerland: [166, 116, 83, 50],
    Japan: [213, 149, 107, 64],
    China: [229, 160, 114, 69],
    UAE: [257, 180, 128, 77],
    "South Africa": [282, 197, 141, 85],
  };
  const TICKETS = ["Standard", "Airstrip", "WLT", "Business"];

  const DEFAULTS = {
    apiKey: "",
    tsKey: "", // Torn Stats key (optional)
    apiPerMin: 30, // max Torn API calls per minute this script makes
    pollSec: 60, // how often each watched player is checked
    bazaarMin: 5, // how often a watched player's bazaar is checked
    myTotal: 0, // your total battle stats (optional, makes win chance better)
    mugMerits: 0, // 0..10
    plunder: 0, // % bonus from a Plunder weapon
    wageShare: 30, // % of a company's daily income per employee assumed to be paid as wages
    useFF: true, // send the key to FF Scouter for stat estimates
    salesScan: true, // watch TornW3B bazaar listings for sales
    salesItems: 20, // how many popular items to scan
    salesScanMin: 10,
    alerts: { mug: true, online: true, offline: false, hosp: true, jail: true, travel: true, land: true, bazaar: true, market: true },
    alertPopup: true,
    alertVibrate: true,
    fab: null,
    tab: "watch",
    hunt: "live",
    live: { running: false, min: 1000000, max: "", onlyAway: false, win: "", item: "", alertMin: 1000000, poolMax: 30, calls: 25 },
    sleep: { types: [], days: 14, minStars: 0, companies: 40, okOnly: true, pick: "mix" },
    search: {
      name: "", faction: "", lvlMin: "", lvlMax: "", inMin: "", inMax: "", okOnly: true, nwMin: "", offMin: "", offMax: "",
      ageMin: "", ageMax: "", gender: "", property: "", ctypes: [], companies: 40, pick: "mix", starsMin: "", starsMax: "", noClothing: true,
      maxStats: "", win: "", hideMugged: 3, sort: "score", check: 25,
    },
    grow: { sources: { networth: true, offences: true, level: false, factions: true }, calls: 10 },
  };

  // ---------------------------------------------------------------- storage
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("twg_" + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("twg_" + k, JSON.stringify(v));
      } catch {
        // Storage full: drop the oldest players from the search list and try once more.
        if (k !== "db") return;
        trimDb(Math.floor(Object.keys(DB).length * 0.7));
        try {
          localStorage.setItem("twg_db", JSON.stringify(DB));
        } catch {}
      }
    },
  };
  const S = Object.assign({}, DEFAULTS, store.get("settings", {}));
  if (S.hunt === "rich") S.hunt = "live";
  if (S.hunt === "sleep") S.hunt = "search"; // Sleeping workers became part of Search
  for (const k of ["alerts", "live", "sleep", "search", "grow"]) S[k] = Object.assign({}, DEFAULTS[k], S[k]);
  S.grow.sources = Object.assign({}, DEFAULTS.grow.sources, S.grow.sources);
  if (!Array.isArray(S.search.ctypes)) S.search.ctypes = [];
  if (S.search.ctype) {
    S.search.ctypes = [+S.search.ctype];
    delete S.search.ctype;
  }
  const save = () => store.set("settings", S);
  const apiKey = () => (S.apiKey || (PDA_KEY.includes("#") ? "" : PDA_KEY)).trim();
  const myId = (() => {
    const m = document.cookie.match(/(?:^|;\s*)uid=(\d+)/);
    return m ? +m[1] : 0;
  })();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();
  const nowS = () => Math.floor(Date.now() / 1000);

  // Watched players: id -> { name, added, seenAt, s: status, trip, ticket, nextAt, bz: { t, items }, bzNext, log: [] }
  const W = store.get("watch", {});
  // Local search list: id -> compact player record (see upsert)
  const DB = store.get("db", {});
  const CO = store.get("companies", {}); // company id -> { t, n, type, stars, inc, emp, emps: { uid: {...} } }
  const ST = store.get("stats", {}); // player id -> { t, bs, bsh, ff, spy }
  const SALES = store.get("sales", {}); // player id -> [{ t, v, item, src }]
  const SNAP = store.get("snap", {}); // "w:itemId" / "m:itemId" -> { t, by: { pid: [qty, price] } }
  const MUGGED = store.get("mugged", {}); // player id -> time
  const POOL = store.get("pool", {}); // live sellers: pid -> { n, src, manual, t, ok, bz, val, la, on, st, abroad, err }
  let LIVE = store.get("live", []); // live sales: [{ t, pid, item, q, v, away, src, pending }]
  const GROW = store.get("grow", { networth: 0, offences: 0, level: 0, facs: {}, facQueue: [] });
  let EVENTS = store.get("events", []); // [{ t, pid, name, kind, text, seen }]
  let CTYPES = store.get("ctypes", null); // { t, types: { id: name } }

  const saveSoon = (() => {
    const pending = new Set();
    let timer = 0;
    const objs = { watch: () => W, db: () => DB, companies: () => CO, stats: () => ST, sales: () => SALES, snap: () => SNAP, mugged: () => MUGGED, grow: () => GROW, events: () => EVENTS, pool: () => POOL, live: () => LIVE };
    let dbTimer = 0;
    return (k) => {
      // The players list can be big, so it is written at most every 15 seconds.
      if (k === "db") {
        if (!dbTimer) dbTimer = setTimeout(() => ((dbTimer = 0), store.set("db", DB)), 15 * SEC);
        return;
      }
      pending.add(k);
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const p of pending) store.set(p, objs[p]());
        pending.clear();
      }, 800);
    };
  })();

  // ---------------------------------------------------------------- http
  function httpGet(url) {
    if (typeof window.PDA_httpGet === "function") return pdaGet(url);
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((res, rej) =>
        GM_xmlhttpRequest({
          method: "GET",
          url,
          timeout: 20000,
          onload: (r) => {
            if (r.status < 200 || r.status >= 300) return rej(new Error("HTTP " + r.status));
            try {
              res(JSON.parse(r.responseText));
            } catch (e) {
              rej(e);
            }
          },
          onerror: () => rej(new Error("Network error")),
          ontimeout: () => rej(new Error("Timed out")),
        })
      );
    }
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), 25 * SEC);
    return fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .finally(() => timer && clearTimeout(timer));
  }

  // Torn PDA silently drops a GET for a URL it already fetched in the last 2s and resolves with
  // undefined, so wait out that window and try again instead of treating it as a response.
  async function pdaGet(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      // Torn PDA sometimes never answers. Give up after 25s instead of waiting forever.
      const r = await Promise.race([window.PDA_httpGet(url, {}), sleep(25 * SEC).then(() => ({ timedOut: true }))]);
      if (r && r.timedOut) throw new Error("no answer (timed out)");
      if (r && r.status != null) {
        const status = +r.status;
        if (status < 200 || status >= 300) throw new Error("HTTP " + status);
        return JSON.parse(r.responseText);
      }
      await sleep(2100);
    }
    throw new Error("Torn PDA didn't return a response");
  }

  const memo = new Map(); // url -> { t, p, done }
  function cached(url, ttl, force, getter) {
    const hit = memo.get(url);
    // A request for this URL still in flight is reused even when forced, so nothing fires twice.
    if (hit && (!hit.done || (!force && now() - hit.t < ttl))) return hit.p;
    const entry = { t: now(), done: false };
    entry.p = (getter || httpGet)(url).then(
      (d) => {
        entry.done = true;
        entry.t = now();
        return d;
      },
      (e) => {
        if (memo.get(url) === entry) memo.delete(url);
        throw e;
      }
    );
    memo.set(url, entry);
    if (memo.size > 600) memo.delete(memo.keys().next().value);
    return entry.p;
  }

  // Torn API calls go through one queue that never goes over S.apiPerMin per minute.
  // User actions jump the queue (hi), background polling waits.
  const apiQ = { hi: [], lo: [], sent: [], running: false };
  let apiUsedTotal = 0,
    lastHiAt = 0;
  function apiSlot(hi) {
    if (hi) lastHiAt = now();
    return new Promise((res) => {
      (hi ? apiQ.hi : apiQ.lo).push(res);
      pumpApi();
    });
  }
  async function pumpApi() {
    if (apiQ.running) return;
    apiQ.running = true;
    try {
      while (apiQ.hi.length || apiQ.lo.length) {
        const cut = now() - MIN;
        while (apiQ.sent.length && apiQ.sent[0] < cut) apiQ.sent.shift();
        const cap = Math.max(5, Math.min(100, +S.apiPerMin || 30));
        if (apiQ.sent.length >= cap) {
          await sleep(apiQ.sent[0] - cut + 50);
          continue;
        }
        const next = apiQ.hi.shift() || apiQ.lo.shift();
        apiQ.sent.push(now());
        apiUsedTotal++;
        next();
        await sleep(120);
      }
    } finally {
      apiQ.running = false;
    }
  }
  const apiQueued = () => apiQ.hi.length + apiQ.lo.length;

  // Official Torn API. path like "/v2/torn/hof?cat=level" or "/user/123?selections=profile".
  // Torn asks tools to stop using a key that is wrong, paused or disabled (or risk an IP ban).
  const DEAD_KEY = { 1: 1, 2: 1, 10: 1, 13: 1, 18: 1 };
  let deadKey = "", // the key that failed, until the user changes it
    deadKeyMsg = "";
  async function torn(path, ttl, opts = {}) {
    const key = opts.key || apiKey();
    if (!key) throw new Error("no API key (add one in ⚙️ Settings)");
    if (deadKey && deadKey === key) throw new Error("API key stopped working: " + deadKeyMsg + ". Check it in ⚙️ Settings.");
    const sep = path.includes("?") ? "&" : "?";
    const url = `${TORN}${path}${sep}key=${encodeURIComponent(key)}&comment=TornWatchGeek`;
    const getter = async (u) => {
      await apiSlot(opts.hi);
      return httpGet(u);
    };
    const d = await cached(url, ttl, opts.force, getter);
    if (d && d.error) {
      memo.delete(url);
      const msg = d.error.error || "Torn API error " + d.error.code;
      if (d.error.code === 5) apiQ.sent.push(...Array(20).fill(now())); // too many requests: back off
      if (DEAD_KEY[d.error.code]) {
        deadKey = key;
        deadKeyMsg = msg;
        apiQ.hi.splice(0).forEach((r) => r());
        apiQ.lo.splice(0).forEach((r) => r());
      }
      throw new Error(msg);
    }
    return d;
  }

  // ---------------------------------------------------------------- helpers
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function short(n) {
    if (n == null || isNaN(n)) return "?";
    const a = Math.abs(n);
    if (a >= 1e12) return "$" + (n / 1e12).toFixed(a >= 1e13 ? 0 : 1) + "T";
    if (a >= 1e9) return "$" + (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
    if (a >= 1e6) return "$" + (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
    if (a >= 1e3) return "$" + Math.round(n / 1e3) + "k";
    return "$" + Math.round(n);
  }
  const money = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
  function num(n) {
    if (n == null || isNaN(n)) return "?";
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(1) + "T";
    if (a >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (a >= 1e3) return Math.round(n / 1e3) + "k";
    return String(Math.round(n));
  }
  function dur(ms) {
    ms = Math.max(0, ms);
    const m = Math.round(ms / MIN);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 48) return h + "h " + (m % 60) + "m";
    return Math.floor(h / 24) + "d " + (h % 24) + "h";
  }
  function ago(ms) {
    if (!ms) return "?";
    const d = now() - ms;
    if (d < MIN) return "just now";
    return dur(d) + " ago";
  }
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const daysSince = (sec) => (sec ? (nowS() - sec) / 86400 : null);
  const profileUrl = (id) => `https://www.torn.com/profiles.php?XID=${id}`;
  const attackUrl = (id) => `https://www.torn.com/loader.php?sid=attack&user2ID=${id}`;
  const bazaarUrl = (id) => `https://www.torn.com/bazaar.php?userId=${id}#/`;
  const numOr = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);
  const vibrate = (p) => {
    try {
      navigator.vibrate && navigator.vibrate(p);
    } catch {}
  };

  // ---------------------------------------------------------------- status + travel
  function parseStatus(st) {
    st = st || {};
    const desc = st.description || "";
    const out = { state: st.state || "", desc, until: +st.until || 0, details: st.details || "" };
    if (out.state === "Traveling") {
      if (/Returning/i.test(desc)) {
        const m = desc.match(/from (.+)$/);
        out.trip = { dir: "back", country: m ? m[1].trim() : "" };
      } else {
        const i = desc.lastIndexOf(" to ");
        out.trip = { dir: "out", country: i >= 0 ? desc.slice(i + 4).trim() : "" };
      }
    } else if (out.state === "Abroad") {
      out.abroad = desc.replace(/^In /, "").trim();
    }
    return out;
  }
  const tripKey = (t) => (t ? t.dir + ":" + t.country : "");
  const flightMs = (country, ticket) => (FLIGHT[country] ? FLIGHT[country][ticket] * MIN : 0);

  // Which tickets still fit, and when each would land.
  // Plane type from Torn's player status (the plane picture on their profile while flying).
  // Learned from real flights first; until then a guess from the name.
  const PLANES = store.get("planes", {}); // plane type -> [count per ticket]
  function planeTicket(plane) {
    if (!plane) return null;
    const c = PLANES[plane];
    if (c && c.some((n) => n > 0)) return { k: c.indexOf(Math.max(...c)), how: "learned" };
    const v = String(plane).toLowerCase();
    if (/business/.test(v)) return { k: 3, how: "guessed" };
    if (/private|jet|wlt/.test(v)) return { k: 2, how: "guessed" };
    if (/light|small|airstrip|prop|cessna/.test(v)) return { k: 1, how: "guessed" };
    if (/airliner|commercial|standard|passenger/.test(v)) return { k: 0, how: "guessed" };
    return null;
  }
  // Which ticket this trip is on, if known: plane type for this flight, then the one learned for the player.
  function tripTicket(w) {
    const pt = w.trip && planeTicket(w.trip.plane);
    if (pt) return { k: pt.k, how: "plane" };
    if (w.ticket != null) return { k: w.ticket, how: "learned" };
    return null;
  }
  function tripEstimate(w, any) {
    const t = w.trip;
    if (!t || !FLIGHT[t.country]) return null;
    const tk = any ? null : tripTicket(w);
    const tickets = tk ? [tk.k] : [0, 1, 2, 3];
    const n = now();
    const known = !!t.depLo; // seen (or told) when they took off
    const opts = [];
    for (const k of tickets) {
      const f = flightMs(t.country, k);
      const lo = (t.depLo || t.depHi) + f * 0.97;
      const hi = t.depHi + f * 1.03 + MIN;
      // A ticket is ruled out once its latest landing has passed while they're still flying.
      if (known && hi < n) continue;
      opts.push({ k, lo, hi, mid: (known ? (t.depLo + t.depHi) / 2 : t.depHi) + f });
    }
    // Flying longer than that ticket allows: they used a different ticket this time.
    if (!opts.length) return tk ? tripEstimate(w, true) : { unknown: true };
    return { known, manual: !!t.manual, single: !!tk, how: tk ? tk.how : "", lo: Math.min(...opts.map((o) => o.lo)), hi: Math.max(...opts.map((o) => o.hi)), opts };
  }
  // Careful wording: only claim what is known.
  // where: "row" (Watch list, tap opens the player) or "page" (player page, box is below).
  function travelLine(w, where) {
    const s = w.s || {};
    if (!s.trip) return "";
    const dest = s.trip.dir === "back" ? "Torn" : s.trip.country || "?";
    const e = tripEstimate(w);
    if (!e) return `✈️ ${esc(dest)}`;
    if (e.unknown) return `✈️ ${esc(dest)} · should land any minute`;
    const tk = e.single ? ` · ${TICKETS[e.opts[0].k]}` : "";
    const src = e.manual ? "take-off time you entered" : "";
    if (!e.known)
      return `✈️ ${esc(dest)}${tk} · Landing time unknown<br><span class="muted tl2">Already flying when tracking started. Latest possible landing: ${clock(e.hi)}. ${where === "page" ? "Enter the take-off time below if you know it." : "Tap to enter take-off time."}</span>`;
    if (e.single) {
      const o = e.opts[0];
      return `✈️ ${esc(dest)}${tk} · lands ~${clock(o.mid)} <small class="muted">(in ${dur(o.mid - now())}${src ? ", " + src : ""})</small>`;
    }
    return `✈️ ${esc(dest)} · lands between ${clock(Math.max(e.lo, now()))} and ${clock(e.hi)}${src ? ` <small class="muted">(${src})</small>` : ""}`;
  }
  // Ask Torn's v2 profile for the plane type when v1 didn't include it (1 call per flight at most).
  async function fetchPlane(id) {
    const w = W[id];
    if (!w || !w.trip || w.trip.plane !== undefined) return;
    w.trip.plane = null; // asked
    try {
      const d = await torn(`/v2/user/${id}/profile`, 30 * SEC, {});
      const st = (d.profile && d.profile.status) || d.status || {};
      const pl = st.plane_image_type || st.travel_type || null;
      if (W[id] && W[id].trip) W[id].trip.plane = pl;
    } catch {}
    saveSoon("watch");
  }

  const planeOf = (p) => (p && p.status && (p.status.plane_image_type || p.status.travel_type)) || undefined;
  // Called with each fresh profile of a watched player. Works out trips, landings and alerts.
  function updateWatched(id, p) {
    const w = W[id];
    if (!w) return;
    const t = now();
    const prev = w.s;
    const cur = parseStatus(p.status);
    cur.la = p.last_action ? { status: p.last_action.status, ts: +p.last_action.timestamp || 0 } : null;
    w.name = p.name || w.name;
    const prevSeen = w.seenAt || 0;
    const fresh = prevSeen && t - prevSeen < Math.max(3, (S.pollSec * 3) / 60) * MIN; // previous check is recent enough to time things

    const late = fresh ? "" : " (while Torn was closed)";
    if (prev) {
      // Online / offline (only when timing means something)
      const a = prev.la && prev.la.status,
        b = cur.la && cur.la.status;
      if (fresh && a && b && a !== b) {
        if (b === "Online") event(id, "online", "came online");
        else if (b === "Offline") event(id, "offline", "went offline");
      }
      // Trips
      if (cur.trip && tripKey(prev.trip) !== tripKey(cur.trip)) {
        w.trip = { dir: cur.trip.dir, country: cur.trip.country, depLo: fresh && !prev.trip ? prevSeen : 0, depHi: t, plane: planeOf(p) };
        const e = tripEstimate(w);
        event(id, "travel", (cur.trip.dir === "back" ? `flying back to Torn from ${cur.trip.country}` : `flying to ${cur.trip.country}`) + (e && !e.unknown && e.known ? ` · lands ${clock(e.lo)}–${clock(e.hi)}` : " (already in the air when tracking started)"));
      }
      if (prev.trip && !cur.trip) {
        const trip = w.trip;
        let learned = "";
        if (trip && trip.depLo && fresh && FLIGHT[trip.country]) {
          // Flight took between (arrLo - depHi) and (arrHi - depLo). Match it to one ticket type.
          const minD = prevSeen - trip.depHi,
            maxD = t - trip.depLo;
          const fits = [0, 1, 2, 3].filter((k) => {
            const f = flightMs(trip.country, k),
              band = f * 0.03 + MIN;
            return maxD >= f - band && minD <= f + band;
          });
          if (fits.length === 1) {
            w.ticket = fits[0];
            learned = ` · flies ${TICKETS[fits[0]]}`;
            // Teach the plane type -> ticket link from this real flight.
            if (trip.plane) {
              PLANES[trip.plane] = PLANES[trip.plane] || [0, 0, 0, 0];
              PLANES[trip.plane][fits[0]]++;
              store.set("planes", PLANES);
            }
          }
        }
        const where = prev.trip.dir === "back" ? "Torn" : prev.trip.country;
        event(id, "land", `landed in ${where}${learned}${late}`);
        w.trip = null;
      }
      // State changes
      if (prev.state !== cur.state) {
        if (cur.state === "Hospital") event(id, "hosp", `went to hospital${cur.until ? " (" + dur(cur.until * 1000 - t) + ")" : ""}${cur.details ? " · " + cur.details : ""}${late}`);
        else if (prev.state === "Hospital") event(id, "hosp", "left hospital" + late);
        if (cur.state === "Jail" || cur.state === "Federal") event(id, "jail", (cur.state === "Federal" ? "went to federal jail" : `went to jail${cur.until ? " (" + dur(cur.until * 1000 - t) + ")" : ""}`) + late);
        else if (prev.state === "Jail") event(id, "jail", "left jail" + late);
      }
    } else if (cur.trip) {
      w.trip = { dir: cur.trip.dir, country: cur.trip.country, depLo: 0, depHi: t, plane: planeOf(p) };
    }
    if (w.trip && cur.trip) {
      if (!w.trip.plane && planeOf(p)) w.trip.plane = planeOf(p);
      // They took off no later than their last action, so that tightens the latest landing.
      const la = cur.la && cur.la.ts ? cur.la.ts * 1000 : 0;
      if (!w.trip.depLo && la && la < w.trip.depHi) w.trip.depHi = la;
    }
    w.s = cur;
    w.seenAt = t;
    w.level = p.level;
    w.job = p.job ? { cid: +p.job.company_id || 0, cname: p.job.company_name || "", ctype: +p.job.company_type || 0, pos: p.job.position || p.job.job || "" } : w.job;
    w.faction = p.faction ? { id: +p.faction.faction_id || 0, name: p.faction.faction_name || "" } : w.faction;
    saveSoon("watch");
  }

  // ---------------------------------------------------------------- events + alerts
  function event(pid, kind, text, extra) {
    const name = (W[pid] && W[pid].name) || (DB[pid] && DB[pid].n) || "#" + pid;
    const ev = Object.assign({ t: now(), pid: +pid, name, kind, text, seen: false }, extra || {});
    EVENTS.unshift(ev);
    if (EVENTS.length > EVENTS_MAX) EVENTS.length = EVENTS_MAX;
    if (W[pid]) {
      W[pid].log = [{ t: ev.t, kind, text }, ...(W[pid].log || [])].slice(0, 60);
      saveSoon("watch");
    }
    saveSoon("events");
    if (S.alerts[kind] && S.alertPopup) showAlert(ev);
    updateBadge();
    if (isOpen() && (view.name === "watch" || view.name === "feed" || (view.name === "player" && view.id === +pid))) renderSoon();
  }
  const ICON = { online: "🟢", offline: "⚪", hosp: "🏥", jail: "🔒", travel: "✈️", land: "🛬", bazaar: "🛒", market: "🏷", sold: "💰", mug: "🔥" };

  let alertQueue = [];
  function showAlert(ev) {
    alertQueue.push(ev);
    if (alertQueue.length > 8) alertQueue.shift();
    drawAlert();
    if (S.alertVibrate) vibrate([120, 60, 120]);
  }
  function drawAlert() {
    const box = $(".alert");
    const ev = alertQueue[0];
    if (!ev) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.innerHTML = `<div class="al-txt"><b>${ICON[ev.kind] || "👁️"} ${esc(ev.name)}</b> ${esc(ev.text)}
      <small>${clock(ev.t)}${alertQueue.length > 1 ? ` · ${alertQueue.length - 1} more` : ""}</small></div>
      <div class="al-btns"><button class="btn sm" data-act="alertOpen" data-id="${ev.pid}">View</button><button class="ib sm" data-act="alertNext">✕</button></div>`;
  }

  // ---------------------------------------------------------------- players list (local "database")
  // Compact record: n name, lv level, la last action (unix s), st state, f faction id, fn faction name,
  // nw networth, off offences, age days old, g gender, pr property, co company id, ct company type,
  // pos position, dic days in company, src where we found them, t updated (ms), pt profile fetched (ms)
  function upsert(id, rec) {
    id = +id;
    if (!id || id === myId) return;
    const cur = DB[id] || {};
    for (const k in rec) if (rec[k] != null && rec[k] !== "") cur[k] = rec[k];
    cur.t = now();
    if (rec.src) cur.src = Array.from(new Set([...(cur.src ? String(cur.src).split(",") : []), rec.src])).join(",");
    DB[id] = cur;
    saveSoon("db");
  }
  function trimDb(keep) {
    const ids = Object.keys(DB).sort((a, b) => (DB[b].t || 0) - (DB[a].t || 0));
    for (const id of ids.slice(keep)) if (!W[id]) delete DB[id];
  }

  const seenResp = new WeakSet(); // profile responses already fed to updateWatched
  async function getProfile(id, opts = {}) {
    // Watched players need fresh data, or old cached status would look like a change.
    let ttl = opts.ttl != null ? opts.ttl : PROFILE_TTL;
    if (W[id]) ttl = Math.min(ttl, 20 * SEC);
    const d = await torn(`/user/${id}?selections=profile`, ttl, opts);
    const job = d.job || {};
    upsert(id, {
      n: d.name,
      lv: d.level,
      la: d.last_action ? +d.last_action.timestamp || null : null,
      st: d.status ? d.status.state : null,
      f: d.faction ? +d.faction.faction_id || 0 : null,
      fn: d.faction ? d.faction.faction_name : null,
      age: d.age,
      g: d.gender,
      pr: d.property,
      co: +job.company_id || 0,
      cn: job.company_name || "",
      ct: +job.company_type || 0,
      pos: job.position || job.job || "",
      pt: now(),
    });
    if (W[id] && !seenResp.has(d)) {
      seenResp.add(d);
      updateWatched(id, d);
    }
    return d;
  }

  // Torn's company types (ids from Torn's job list). Used when the key can't read 'torn -> companies'.
  const BUILTIN_CTYPES = {
    1: "Hair Salon", 2: "Law Firm", 3: "Flower Shop", 4: "Car Dealership", 5: "Clothing Store", 6: "Gun Shop", 7: "Game Shop",
    8: "Candle Shop", 9: "Toy Shop", 10: "Adult Novelties", 11: "Cyber Cafe", 12: "Grocery Store", 13: "Theater", 14: "Sweet Shop",
    15: "Cruise Line", 16: "Television Network", 18: "Zoo", 19: "Firework Stand", 20: "Property Broker", 21: "Furniture Store",
    22: "Gas Station", 23: "Music Store", 24: "Nightclub", 25: "Pub", 26: "Gents Strip Club", 27: "Restaurant", 28: "Oil Rig",
    29: "Fitness Center", 30: "Mechanic Shop", 31: "Amusement Park", 32: "Lingerie Store", 33: "Meat Warehouse", 34: "Farm",
    35: "Software Corporation", 36: "Ladies Strip Club", 37: "Private Security Firm", 38: "Mining Corporation", 39: "Detective Agency",
    40: "Logistics Management",
  };
  if (!CTYPES) CTYPES = { t: 0, types: BUILTIN_CTYPES };
  async function companyTypes() {
    if (CTYPES && CTYPES.t && now() - CTYPES.t < 7 * DAY) return CTYPES.types;
    try {
      const d = await torn(`/torn/?selections=companies`, DAY, { hi: true });
      const types = {};
      for (const [id, c] of Object.entries(d.companies || {})) types[id] = c.name;
      if (!Object.keys(types).length) throw new Error("empty");
      CTYPES = { t: now(), types };
      store.set("ctypes", CTYPES);
    } catch {
      // Some keys aren't allowed to read this. The built-in list works just as well.
      CTYPES = { t: now() - 6 * DAY, types: BUILTIN_CTYPES }; // try Torn again in a day
    }
    return CTYPES.types;
  }
  const typeName = (id) => (CTYPES && CTYPES.types[id]) || (id ? "Type " + id : "");
  const isClothing = (ct) => /clothing/i.test(typeName(ct));

  async function getCompany(cid, opts = {}) {
    const c = CO[cid];
    if (c && c.emps && c.v === 2 && !opts.force && now() - c.t < COMPANY_TTL) return c;
    // Workers may come with "profile" or only with "employees" (company_employees). Ask for both,
    // and if Torn refuses "employees" for someone else's company, use the profile alone.
    let d;
    if (!getCompany.noEmployees) {
      try {
        d = await torn(`/company/${cid}?selections=profile,employees`, COMPANY_TTL, opts);
      } catch (e) {
        if (!/relation|access|permission|selection|field/i.test(e.message)) throw e;
        getCompany.noEmployees = true;
      }
    }
    if (!d) d = await torn(`/company/${cid}?selections=profile`, COMPANY_TTL, opts);
    const co = d.company || d;
    const emps = {};
    for (const [uid, e] of Object.entries(d.company_employees || co.employees || {})) {
      const la = e.last_action || {};
      emps[uid] = { n: e.name, pos: e.position, dic: +e.days_in_company || 0, la: +la.timestamp || null, st: (e.status && e.status.state) || "" };
      upsert(uid, { n: e.name, la: emps[uid].la, st: emps[uid].st || null, co: +cid, ct: +co.company_type || null, pos: e.position, dic: emps[uid].dic, src: "company" });
    }
    CO[cid] = {
      v: 2,
      t: now(),
      n: co.name,
      type: +co.company_type || 0,
      stars: +co.rating || 0,
      inc: +co.daily_income || 0,
      wk: +co.weekly_income || 0,
      emp: +co.employees_hired || Object.keys(emps).length,
      emps,
    };
    saveSoon("companies");
    return CO[cid];
  }

  // ---------------------------------------------------------------- battle stats (FF Scouter + Torn Stats)
  const ffWait = new Map(); // id -> [resolvers]
  const ffTried = {}; // id -> time of the last lookup that returned nothing
  const needStats = (id) => apiKey() && S.useFF && !(ST[id] && now() - ST[id].t < STATS_TTL) && !(ffTried[id] && now() - ffTried[id] < 5 * MIN);
  let ffTimer = 0,
    ffErr = "",
    ffSent = [];
  function stats(id) {
    const s = ST[id];
    if (!needStats(id)) return Promise.resolve(s || null);
    return new Promise((res) => {
      if (!ffWait.has(+id)) ffWait.set(+id, []);
      ffWait.get(+id).push(res);
      clearTimeout(ffTimer);
      ffTimer = setTimeout(flushFF, 400);
    });
  }
  async function flushFF() {
    if (!ffWait.size) return;
    // FF Scouter allows about 20 calls a minute per IP. Stay under that.
    const cut = now() - MIN;
    ffSent = ffSent.filter((x) => x > cut);
    if (ffSent.length >= 15) {
      ffTimer = setTimeout(flushFF, ffSent[0] - cut + 100);
      return;
    }
    const ids = [...ffWait.keys()].slice(0, 100);
    const waiters = ids.map((id) => [id, ffWait.get(id)]);
    ids.forEach((id) => ffWait.delete(id));
    ffSent.push(now());
    try {
      const d = await httpGet(`${FFS}?key=${encodeURIComponent(apiKey())}&targets=${ids.join(",")}`);
      if (d && d.error) throw new Error(d.error.error || d.error.message || d.error);
      const arr = Array.isArray(d) ? d : d.data || d.results || [];
      ffErr = "";
      for (const k of Object.keys(ffTried)) delete ffTried[k];
      for (const r of arr) {
        const id = +(r.player_id || r.id);
        if (!id) continue;
        ST[id] = Object.assign({}, ST[id], { t: now(), ff: r.fair_fight != null ? +r.fair_fight : null, bs: r.bs_estimate != null ? +r.bs_estimate : null, bsh: r.bs_estimate_human || null, at: r.last_updated || null });
      }
    } catch (e) {
      ffErr = /key|register|auth|40[13]/i.test(e.message) ? "FF Scouter: register your API key once at ffscouter.com" : "FF Scouter: " + e.message;
    }
    for (const [id, rs] of waiters) {
      if (!ST[id] || now() - ST[id].t > STATS_TTL) ffTried[id] = now();
      rs.forEach((r) => r(ST[id] || null));
    }
    saveSoon("stats");
    if (ffWait.size) ffTimer = setTimeout(flushFF, 400);
  }
  async function tornStatsSpy(id) {
    try {
      const d = await cached(`${TS}/${encodeURIComponent(S.tsKey)}/spy/user/${id}`, DAY);
      const sp = d && d.spy;
      ST[id] = Object.assign({ t: 0 }, ST[id], { spyT: now() });
      if (sp && sp.status !== false && sp.total) ST[id].spy = { total: +sp.total, str: +sp.strength, def: +sp.defense, spd: +sp.speed, dex: +sp.dexterity, at: +sp.timestamp || 0 };
    } catch {}
  }
  async function loadMyStats() {
    if (S.myTotal || !apiKey()) return;
    try {
      const d = await torn(`/user/?selections=battlestats`, DAY, {});
      const tot = (+d.strength || 0) + (+d.defense || 0) + (+d.speed || 0) + (+d.dexterity || 0);
      if (tot > 0) {
        S.myTotal = tot;
        save();
      }
    } catch {} // a Public key can't read battle stats; that's fine
  }

  // Win chance from estimated stats. FF = 1 + 8/3 × (their stat score ÷ yours), capped at 3.
  function winOf(id) {
    const s = ST[id];
    if (!s || (s.ff == null && !s.bs && !s.spy)) return { k: "unk", label: "?", r: null };
    const theirs = s.spy ? s.spy.total : s.bs;
    let r = null;
    if (S.myTotal && theirs) r = theirs / S.myTotal;
    else if (s.ff != null && s.ff < 2.99) r = Math.pow(((s.ff - 1) * 3) / 8, 2); // stat score grows with √stats
    if (r == null) return { k: "risky", label: "🟠 Risky", r: null, note: "as strong as you or more" };
    if (r < 0.35) return { k: "easy", label: "🟢 Easy", r };
    if (r < 0.75) return { k: "likely", label: "🟡 Likely", r };
    if (r < 1.25) return { k: "risky", label: "🟠 Risky", r };
    return { k: "avoid", label: "🔴 Avoid", r };
  }
  const WIN_ORDER = { easy: 0, likely: 1, risky: 2, unk: 3, avoid: 4 };
  function statsChip(id) {
    const s = ST[id];
    if (!s || (s.ff == null && !s.bs && !s.spy)) return ffTried[id] ? `<span class="pill unk">stats ?</span>` : `<span class="pill even">stats …</span>`;
    const w = winOf(id);
    const bs = s.spy ? `${num(s.spy.total)} <small>spy</small>` : s.bs ? "~" + (s.bsh || num(s.bs)) : "?";
    return `<span class="pill ${w.k}">${w.label}</span> <span class="small">${bs}${s.ff != null ? ` · FF ${s.ff.toFixed(2)}` : ""}</span>`;
  }

  // Rough mug estimate from cash on hand.
  function mugRange(cash, ct, stars) {
    if (!cash) return null;
    const bonus = (1 + 0.05 * Math.min(10, +S.mugMerits || 0)) * (1 + (+S.plunder || 0) / 100);
    let lo = cash * 0.05 * bonus,
      hi = cash * 0.1 * bonus;
    if (isClothing(ct) && stars >= 7) {
      lo *= 0.25;
      hi *= 0.25;
    }
    return [lo, hi];
  }

  // ---------------------------------------------------------------- watching (background)
  let pollBusy = false;
  async function pollWatch() {
    if (pollBusy || document.hidden || !apiKey() || deadKey === apiKey()) return;
    pollBusy = true;
    try {
      const t = now();
      const due = Object.keys(W).filter((id) => !W[id].nextAt || W[id].nextAt <= t);
      for (const id of due) {
        W[id].nextAt = t + Math.max(30, +S.pollSec || 60) * SEC;
        getProfile(id, { ttl: 20 * SEC })
          .then(() => {
            W[id] && (W[id].err = "");
            if (W[id] && W[id].trip && W[id].trip.plane === undefined) fetchPlane(id);
            if (isOpen() && (view.name === "watch" || (view.name === "player" && view.id === +id))) renderSoon();
          })
          .catch((e) => {
            if (W[id]) W[id].err = e.message;
          });
        if (W[id].bazaar !== false && (!W[id].bzNext || W[id].bzNext <= t)) {
          W[id].bzNext = t + Math.max(2, +S.bazaarMin || 5) * MIN;
          checkBazaar(id).catch(() => {});
        }
      }
    } finally {
      pollBusy = false;
    }
  }

  async function checkBazaar(id) {
    const d = await torn(`/user/${id}?selections=bazaar`, 60 * SEC, {});
    const items = parseBazaar(d.bazaar);
    const w = W[id];
    if (!w) return;
    const old = w.bz && w.bz.items;
    if (old) {
      let soldV = 0;
      const soldTxt = [],
        listTxt = [];
      for (const [k, it] of Object.entries(items)) {
        const o = old[k];
        if (!o) listTxt.push(`${it.q}× ${it.name} @ ${short(it.p)}`);
        else if (it.q > o.q) listTxt.push(`+${it.q - o.q}× ${it.name} @ ${short(it.p)}`);
      }
      for (const [k, o] of Object.entries(old)) {
        const it = items[k];
        const gone = o.q - (it ? it.q : 0);
        if (gone > 0) {
          soldV += gone * o.p;
          soldTxt.push(`${gone}× ${o.name}`);
        }
      }
      if (listTxt.length) event(id, "bazaar", "listed " + listTxt.slice(0, 3).join(", ") + (listTxt.length > 3 ? ` +${listTxt.length - 3} more` : ""));
      if (soldV > 0) {
        event(id, "bazaar", `sold or removed ${soldTxt.slice(0, 3).join(", ")}${soldTxt.length > 3 ? " …" : ""} (~${short(soldV)})`);
        addSale(id, soldV, soldTxt.join(", "), "bazaar");
        if (!POOL[id]) {
          const s = w.s || {};
          const m = { la: s.la && s.la.ts, on: s.la && s.la.status, st: s.state, abroad: s.abroad };
          const away = awayNow(m) || (m.on !== "Online" && m.la && w.bz && m.la * 1000 < w.bz.t ? "offline" : "");
          for (const x of bazaarDrops(old, items)) pushLive({ t: now(), pid: +id, item: x.item, q: x.q, v: x.v, away, src: "watch" });
        }
      }
    }
    w.bz = { t: now(), items };
    saveSoon("watch");
  }

  function addSale(pid, v, item, src) {
    pid = +pid;
    if (!pid || pid === myId || !(v > 0)) return;
    const list = (SALES[pid] || []).filter((s) => now() - s.t < 7 * DAY);
    list.push({ t: now(), v: Math.round(v), item, src });
    SALES[pid] = list.slice(-40);
    saveSoon("sales");
  }
  function salesIn(pid, hours) {
    const cut = now() - hours * HOUR;
    return (SALES[pid] || []).filter((s) => s.t >= cut).reduce((a, s) => a + s.v, 0);
  }

  // ---------------------------------------------------------------- Live sales engine
  // A pool of big sellers is checked one after another (profile + bazaar in one call).
  // Stock that goes down is a sale. A sale counts as 🔥 "away" when the seller hasn't been active
  // since before it, or is flying, or is abroad anywhere except the Cayman Islands (which has a bank).
  function parseBazaar(raw) {
    if (!raw) raw = [];
    if (!Array.isArray(raw)) raw = Object.values(raw);
    const items = {};
    for (const it of raw) {
      const iid = +(it.ID || it.id || it.item_id || 0);
      if (!iid) continue;
      const q = +(it.quantity != null ? it.quantity : it.amount) || 0;
      const p = +(it.price != null ? it.price : it.cost) || 0;
      const key = iid + ":" + p;
      items[key] = { id: iid, name: it.name || "Item " + iid, q: (items[key] ? items[key].q : 0) + q, p };
    }
    return items;
  }
  function bazaarDrops(old, items) {
    const out = [];
    for (const [k, o] of Object.entries(old || {})) {
      const it = items[k];
      const gone = o.q - (it ? it.q : 0);
      if (gone > 0) out.push({ item: o.name, q: gone, v: gone * o.p });
    }
    return out;
  }
  function awayNow(m) {
    if (!m) return "";
    if (m.st === "Traveling") return "flying ✈️";
    if (m.st === "Abroad" && !/cayman/i.test(m.abroad || "")) return "in " + (m.abroad || "another country");
    return "";
  }
  // Came back after the sale and is somewhere with a bank.
  const isBanked = (r, m) => !!(m && m.la && m.la * 1000 > r.t && !awayNow(m));
  // Pool sellers have their own status; watched players use the Watch tab's status.
  function sellerOf(pid) {
    if (POOL[pid]) return POOL[pid];
    const w = W[pid];
    if (!w || !w.s) return null;
    return { n: w.name, la: w.s.la && w.s.la.ts, on: w.s.la && w.s.la.status, st: w.s.state, abroad: w.s.abroad };
  }
  const isHot = (r) => !r.pending && !!r.away && !isBanked(r, sellerOf(r.pid));
  function unbanked(pid) {
    return LIVE.filter((r) => r.pid === +pid && isHot(r)).reduce((a, r) => a + r.v, 0);
  }

  function addToPool(pid, name, src, manual) {
    pid = +pid;
    if (!pid || pid === myId) return;
    const m = POOL[pid];
    if (m) {
      if (manual) m.manual = true;
      if (name && !m.n) m.n = name;
      saveSoon("pool");
      return;
    }
    const max = Math.max(1, +S.live.poolMax || 30);
    const ids = Object.keys(POOL);
    if (!manual && ids.length >= max) {
      // Make room by dropping the auto-added seller with the smallest bazaar and no recent sales.
      const recent = (id) => LIVE.some((r) => r.pid === +id && now() - r.t < 6 * HOUR);
      const drop = ids.filter((id) => !POOL[id].manual && !recent(id)).sort((a, b) => (POOL[a].val || 0) - (POOL[b].val || 0))[0];
      if (!drop) return;
      delete POOL[drop];
    }
    POOL[pid] = { n: name || (DB[pid] && DB[pid].n) || "", src, manual: !!manual, t: 0, added: now() };
    saveSoon("pool");
  }

  let poolFillAt = store.get("poolFillAt", 0);
  async function fillPool(force) {
    if (!force && now() - poolFillAt < 30 * MIN) return;
    poolFillAt = now();
    store.set("poolFillAt", poolFillAt);
    try {
      const list = await weeklyTopBazaars();
      list.forEach((b) => {
        upsert(b.id, { n: b.name, wk: b.weekly, src: "weekly" });
        addToPool(b.id, b.name, "weekly");
      });
    } catch {}
    // Biggest sellers seen on TornW3B
    const tot = {};
    for (const [k, sn] of Object.entries(SNAP)) {
      if (!k.startsWith("w:")) continue;
      for (const [pid, [q, p]] of Object.entries(sn.by)) tot[pid] = (tot[pid] || 0) + q * p;
    }
    Object.entries(tot)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, +S.live.poolMax || 30))
      .forEach(([pid]) => addToPool(pid, (DB[pid] && DB[pid].n) || "", "w3b"));
  }

  function pushLive(row) {
    const before = unbanked(row.pid);
    LIVE.unshift(row);
    LIVE.sort((a, b) => (b.seen || b.t) - (a.seen || a.t));
    if (LIVE.length > 400) LIVE.length = 400;
    saveSoon("live");
    stats(row.pid).then(drawLiveSoon);
    maybeMugAlert(row.pid, before);
    drawLiveSoon();
  }
  function maybeMugAlert(pid, before) {
    const total = unbanked(pid);
    const at = +S.live.alertMin || +S.live.min || 0; // empty = same as the list's minimum
    if (!total || total < at || before >= at) return;
    const m = sellerOf(pid);
    const r = LIVE.find((x) => x.pid === +pid && isHot(x));
    const w = winOf(pid);
    event(pid, "mug", `sold ~${short(total)} while away · ${awayText(r, m)}${w.k !== "unk" ? " · " + w.label : ""}`);
  }

  let liveLast = 0,
    liveAt = 0;
  async function checkSeller(pid, hi) {
    const m = POOL[pid];
    if (!m) return;
    m.t = now(); // schedule first, so the same seller isn't picked twice
    const prevOk = m.ok || 0;
    let d;
    try {
      d = await torn(`/user/${pid}?selections=profile,bazaar`, 5 * SEC, { hi });
    } catch (e) {
      m.err = e.message;
      saveSoon("pool");
      return;
    }
    const st = parseStatus(d.status);
    const la = d.last_action || {};
    Object.assign(m, { n: d.name || m.n, la: +la.timestamp || m.la || 0, on: la.status || "", st: st.state, abroad: st.abroad || "", ok: now(), err: "" });
    upsert(pid, { n: d.name, lv: d.level, la: m.la || null, st: st.state || null, f: d.faction ? +d.faction.faction_id || 0 : null, fn: d.faction ? d.faction.faction_name : null });
    const items = parseBazaar(d.bazaar);
    m.val = Object.values(items).reduce((a, i) => a + i.q * i.p, 0);
    // Torn caches and delays bazaar data on purpose. bazaar_timestamp says how old this copy is,
    // so a sale happened between the previous copy's time and this one's.
    const bzT = (+d.bazaar_timestamp || 0) * 1000 || now();
    const prevBzT = m.bzT || prevOk;
    if (m.bz && bzT !== m.bzT) {
      // Not online and no action since before the sale could have happened: they weren't there for it.
      const away = awayNow(m) || (m.on !== "Online" && m.la && prevBzT && m.la * 1000 < prevBzT ? "offline" : "");
      for (const s of bazaarDrops(m.bz, items)) {
        pushLive({ t: bzT, seen: now(), pid: +pid, item: s.item, q: s.q, v: s.v, away, src: "pool" });
        addSale(pid, s.v, `${s.q}× ${s.item}`, "bazaar");
      }
    }
    if (!m.bz || bzT !== m.bzT) {
      m.bz = items;
      m.bzT = bzT;
    }
    // Sales spotted elsewhere (TornW3B) waiting for this status check
    let changed = false;
    for (const r of LIVE) {
      if (r.pid !== +pid || !r.pending) continue;
      r.pending = false;
      // TornW3B can lag a few minutes, so allow some slack before the spotted time.
      r.away = awayNow(m) || (m.on !== "Online" && m.la && m.la * 1000 < r.t - 5 * MIN ? "offline" : "");
      changed = true;
    }
    if (changed) {
      saveSoon("live");
      maybeMugAlert(pid, 0);
    }
    liveLast = now();
    saveSoon("pool");
    drawLiveSoon();
  }

  function liveTick() {
    if (!S.live.running || document.hidden || !apiKey() || deadKey === apiKey()) return;
    if (apiQueued() > 0 || now() - lastHiAt < 4 * SEC) return; // watched players and your taps go first
    const gap = 60000 / Math.max(1, Math.min(100, +S.live.calls || 25));
    if (now() - liveAt < gap) return;
    const ids = Object.keys(POOL);
    if (!ids.length) {
      fillPool(false);
      return;
    }
    liveAt = now();
    const next = ids.sort((a, b) => (POOL[a].t || 0) - (POOL[b].t || 0))[0];
    // Torn caches bazaar data for at least 30s, so checking a seller more often wastes calls.
    if (now() - (POOL[next].t || 0) < 30 * SEC) return;
    checkSeller(+next, false);
    if (Math.random() < 0.02) fillPool(false);
  }

  // TornW3B bazaar scan: compare listings between scans; a drop in stock means a sale.
  let w3bBusy = false,
    w3bLast = store.get("w3bLast", 0),
    w3bStatus = "";
  async function scanSales(force) {
    if (w3bBusy || (!S.salesScan && !force) || (document.hidden && !force)) return;
    if (!force && now() - w3bLast < Math.max(5, +S.salesScanMin || 10) * MIN) return;
    w3bBusy = true;
    w3bStatus = "Scanning bazaars…";
    try {
      const list = await cached(W3B, 30 * MIN);
      const items = (list.items || [])
        .filter((i) => i.item_id > 0 && i.lowest_price > 0 && i.total_bazaars > 0)
        .sort((a, b) => b.lowest_price * Math.min(b.total_bazaars, 300) - a.lowest_price * Math.min(a.total_bazaars, 300))
        .slice(0, Math.max(5, Math.min(60, +S.salesItems || 20)));
      let n = 0;
      for (const it of items) {
        try {
          const d = await cached(`${W3B}/${it.item_id}`, 4 * MIN, true);
          diffListings("w:" + it.item_id, it.item_name || d.item_name, (d.listings || []).map((l) => ({ pid: +l.player_id, name: l.player_name, q: +l.quantity, p: +l.price })), "bazaar");
          n++;
        } catch {}
        await sleep(700);
      }
      w3bLast = now();
      store.set("w3bLast", w3bLast);
      w3bStatus = `Checked ${n} popular items at ${clock(w3bLast)}`;
    } catch (e) {
      w3bStatus = "TornW3B: " + e.message;
    } finally {
      w3bBusy = false;
    }
    if (isOpen() && view.name === "hunt") renderSoon();
  }

  // Compare two snapshots of one item's listings. Shared by TornW3B and the Item Market page.
  function diffListings(key, itemName, listings, src) {
    const by = {};
    let maxP = 0;
    for (const l of listings) {
      if (!l.pid || !l.q) continue;
      const cur = by[l.pid];
      by[l.pid] = cur ? [cur[0] + l.q, Math.min(cur[1], l.p)] : [l.q, l.p];
      maxP = Math.max(maxP, l.p);
      if (l.name) upsert(l.pid, { n: l.name, src: src === "market" ? "market" : "bazaar" });
    }
    const old = SNAP[key];
    if (old && now() - old.t < 3 * HOUR) {
      for (const [pid, [oq, op]] of Object.entries(old.by)) {
        const cur = by[pid];
        // A listing that vanished only counts if it was cheap enough to still be on the list.
        const gone = cur ? oq - cur[0] : op <= maxP ? oq : 0;
        if (gone > 0 && gone <= oq) {
          const v = gone * op;
          addSale(pid, v, `${gone}× ${itemName}`, src);
          if (src === "bazaar" && S.live.running && !POOL[pid] && v >= Math.min(+S.live.min || 0, +S.live.alertMin || 0)) {
            addToPool(pid, (DB[pid] && DB[pid].n) || "", "w3b");
            pushLive({ t: now(), pid: +pid, item: itemName, q: gone, v, away: "", pending: true, src: "w3b" });
            checkSeller(+pid, true);
          }
          if (W[pid]) event(pid, src === "market" ? "market" : "bazaar", `sold ${gone}× ${itemName} (~${short(v)})${src === "market" ? " on the Item Market" : ""}`);
        }
      }
    }
    // Watched players: new listings
    for (const [pid, [q, p]] of Object.entries(by)) {
      const o = old && old.by[pid];
      if (W[pid] && (!o || q > o[0])) event(pid, src === "market" ? "market" : "bazaar", `listed ${o ? "+" + (q - o[0]) : q}× ${itemName} @ ${short(p)}${src === "market" ? " on the Item Market" : ""}`);
    }
    SNAP[key] = { t: now(), by };
    const keys = Object.keys(SNAP);
    if (keys.length > 150) keys.sort((a, b) => SNAP[a].t - SNAP[b].t).slice(0, keys.length - 150).forEach((k) => delete SNAP[k]);
    saveSoon("snap");
  }

  // ---------------------------------------------------------------- Item Market page reading
  function marketItemId() {
    if (!/sid=ItemMarket/i.test(location.href)) return 0;
    const m = location.href.match(/itemID=(\d+)/i);
    return m ? +m[1] : 0;
  }
  let imTimer = 0,
    imLastSig = "";
  function scanMarketPage() {
    const iid = marketItemId();
    // Torn's rules: only read a page you are actively looking at.
    if (!iid || document.hidden) return;
    const links = [...document.querySelectorAll('a[href*="profiles.php?XID="]')].filter((a) => !host.contains(a));
    const rows = [];
    for (const a of links) {
      const pid = +((a.getAttribute("href") || "").match(/XID=(\d+)/) || [])[1];
      if (!pid) continue;
      // Climb to the row that holds the price.
      let row = a.parentElement;
      for (let i = 0; i < 6 && row && !/\$\s?[\d,]{2,}/.test(row.textContent || ""); i++) row = row.parentElement;
      if (!row || (row.textContent || "").length > 400) continue;
      // Read each text piece on its own: price and quantity sit in separate cells with no space between.
      const parts = [];
      const tw = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      while (tw.nextNode()) {
        const v = tw.currentNode.nodeValue.trim();
        if (v) parts.push(v);
      }
      const pi = parts.findIndex((v) => /^\$\s?[\d,]+$/.test(v));
      if (pi < 0) continue;
      const price = +parts[pi].replace(/[$,\s]/g, "");
      const qs = parts.slice(pi + 1).find((v) => /^[\d,]+$/.test(v));
      const q = qs ? +qs.replace(/,/g, "") : 1;
      const name = (a.textContent || "").trim() || (a.querySelector("img") && a.querySelector("img").alt) || "";
      rows.push({ pid, name, q, p: price, row });
    }
    if (!rows.length) return;
    // Highlight watched players' listings.
    for (const r of rows) {
      if (W[r.pid]) {
        r.row.style.outline = "2px solid #ffd43b";
        r.row.style.outlineOffset = "-2px";
        r.row.title = "Torn Watch Geek: you're watching this player";
      }
    }
    const sig = iid + "|" + rows.map((r) => r.pid + ":" + r.q + ":" + r.p).join(",");
    if (sig === imLastSig) return;
    imLastSig = sig;
    const itemName = (document.querySelector('[class*="itemName"], [class*="title"] h4, [class*="item-name"]') || {}).textContent || "item " + iid;
    diffListings("m:" + iid, itemName.trim().slice(0, 40), rows, "market");
    for (const r of rows) {
      const big = r.q * r.p;
      upsert(r.pid, { n: r.name || null, src: "market", ml: big, mlt: now() });
    }
  }

  // ---------------------------------------------------------------- Hunt data
  async function weeklyTopBazaars() {
    const d = await torn(`/v2/market/bazaar`, HOUR, { hi: true });
    const b = d.bazaar || {};
    return (b.top_grossing || []).map((x) => ({ id: +x.id, name: x.name, weekly: +x.weekly_income || 0, open: x.is_open }));
  }

  // Grow the local players list from Hall of Fame pages and faction member lists.
  let growBusy = false,
    growMsg = "";
  async function growDb(calls) {
    if (growBusy) return;
    growBusy = true;
    let added = 0;
    const before = Object.keys(DB).length;
    try {
      const srcs = Object.entries(S.grow.sources).filter(([, on]) => on).map(([k]) => k);
      if (!srcs.length) throw new Error("turn on at least one source");
      for (let i = 0; i < calls; i++) {
        const src = srcs[i % srcs.length];
        growMsg = `Finding players… ${i + 1}/${calls}`;
        renderGrowMsg();
        if (src === "factions") {
          const fid = nextFaction();
          if (!fid) continue;
          const d = await torn(`/v2/faction/${fid}/members`, DAY, { hi: true });
          for (const m of d.members || []) {
            const st = m.status || {};
            upsert(m.id, { n: m.name, lv: m.level, la: m.last_action ? +m.last_action.timestamp || null : null, st: st.state || null, f: fid, src: "faction" });
          }
          GROW.facs[fid] = now();
        } else {
          const off = GROW[src] || 0;
          const d = await torn(`/v2/torn/hof?cat=${src}&limit=100&offset=${off}`, DAY, { hi: true });
          const list = d.hof || [];
          for (const h of list) {
            const rec = { n: h.username || h.name, lv: h.level, la: +h.last_action || null, f: +h.faction_id || 0, age: +h.age_in_days || null, src: "hof" };
            if (src === "networth") rec.nw = +h.value || null;
            if (src === "offences") rec.off = +h.value || null;
            upsert(h.id, rec);
            if (rec.f && !GROW.facs[rec.f] && !GROW.facQueue.includes(rec.f) && GROW.facQueue.length < 500) GROW.facQueue.push(rec.f);
          }
          GROW[src] = list.length < 100 ? 0 : off + 100;
        }
        saveSoon("grow");
      }
      added = Object.keys(DB).length - before;
      growMsg = `Added ${added} new players. List has ${Object.keys(DB).length}.`;
    } catch (e) {
      growMsg = "Couldn't finish: " + e.message;
    } finally {
      growBusy = false;
      if (Object.keys(DB).length > DB_MAX) trimDb(DB_MAX);
      saveSoon("db");
    }
    if (isOpen() && view.name === "hunt") render();
  }
  function nextFaction() {
    // Factions found in the Hall of Fame first, then factions of players already in the list.
    while (GROW.facQueue.length) {
      const f = GROW.facQueue.shift();
      if (!GROW.facs[f] || now() - GROW.facs[f] > 14 * DAY) return f;
    }
    for (const p of Object.values(DB)) if (p.f && (!GROW.facs[p.f] || now() - GROW.facs[p.f] > 14 * DAY)) return p.f;
    return 0;
  }

  // ---------------------------------------------------------------- UI shell
  const host = document.createElement("div");
  host.id = "torn-watch-geek";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS()}</style>
    <button class="fab" data-act="toggle" title="Torn Watch Geek (drag to move)"><span class="fab-ico"><svg class="eye" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 5C6.5 5 2.3 9.1 1 12c1.3 2.9 5.5 7 11 7s9.7-4.1 11-7c-1.3-2.9-5.5-7-11-7z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.6" fill="currentColor"/></svg></span><span class="fab-badge" hidden></span></button>
    <div class="scrim" data-act="close" hidden></div>
    <section class="panel" hidden role="dialog" aria-label="Torn Watch Geek">
      <header class="top">
        <button class="ib" data-act="back" title="Back" hidden>‹</button>
        <div class="title">Torn Watch Geek</div>
        <button class="ib" data-act="settings" title="Settings">⚙️</button>
        <button class="ib" data-act="close" title="Close">✕</button>
      </header>
      <nav class="tabs">
        <button class="tab" data-act="tab" data-tab="watch">👁️ Watch</button>
        <button class="tab" data-act="tab" data-tab="hunt">🎯 Hunt</button>
        <button class="tab" data-act="tab" data-tab="feed">🔔 Feed</button>
      </nav>
      <div class="body"></div>
    </section>
    <div class="alert" hidden role="alert"></div>
    <div class="toast" hidden></div>`;
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const body = () => $(".body");

  const view = { name: S.tab || "watch", id: 0, stack: [], results: null, busy: "", msg: "" };

  function open() {
    $(".panel").hidden = false;
    $(".scrim").hidden = false;
    render();
  }
  function close() {
    $(".panel").hidden = true;
    $(".scrim").hidden = true;
  }
  const isOpen = () => !$(".panel").hidden;

  let toastT = 0;
  function toast(msg, kind, ms = 2200) {
    const t = $(".toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    clearTimeout(toastT);
    if (ms) toastT = setTimeout(() => (t.hidden = true), ms);
  }

  function go(name, id) {
    if (["watch", "hunt", "feed"].includes(name)) {
      view.stack = [];
      S.tab = name;
      save();
    } else view.stack.push({ name: view.name, id: view.id });
    view.name = name;
    view.id = id || 0;
    render();
    body().scrollTop = 0;
  }
  function back() {
    const prev = view.stack.pop() || { name: S.tab || "watch" };
    view.name = prev.name;
    view.id = prev.id || 0;
    render();
  }

  let renderT = 0;
  const renderSoon = () => {
    clearTimeout(renderT);
    renderT = setTimeout(() => {
      // Don't redraw while the user is typing in a box.
      const a = root.activeElement;
      if (a && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) return;
      if (isOpen()) render();
    }, 250);
  };

  function render() {
    const top = ["watch", "hunt", "feed"].includes(view.name);
    $("[data-act=back]").hidden = top;
    $$(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === (top ? view.name : S.tab)));
    const titles = { settings: "Settings", player: (W[view.id] && W[view.id].name) || (DB[view.id] && DB[view.id].n) || "Player" };
    $(".title").textContent = titles[view.name] || "Torn Watch Geek";
    ({ watch: renderWatch, hunt: renderHunt, feed: renderFeed, settings: renderSettings, player: renderPlayer })[view.name]();
  }

  function noKeyBox() {
    if (deadKey && deadKey === apiKey()) return `<div class="warnbox r">Your API key stopped working (${esc(deadKeyMsg)}). The script has stopped using it. Fix it in <button class="link" data-act="settings">⚙️ Settings</button>.</div>`;
    return apiKey() ? "" : `<div class="warnbox">Add your Torn API key in <button class="link" data-act="settings">⚙️ Settings</button> (a <b>Public</b> key is enough). In Torn PDA it's filled in for you.</div>`;
  }

  // ---------------------------------------------------------------- Watch tab
  function profileContext() {
    const m = location.href.match(/profiles\.php\?XID=(\d+)/i);
    return m ? +m[1] : 0;
  }
  function statusBits(s) {
    if (!s) return { dot: "", text: "checking…" };
    const la = s.la || {};
    const dot = la.status === "Online" ? "on" : la.status === "Idle" ? "idle" : "";
    let text = s.state || "?";
    let cls = "";
    if (s.state === "Hospital" || s.state === "Jail" || s.state === "Federal") {
      cls = "r";
      text = `${s.state === "Federal" ? "Federal jail" : s.state}${s.until ? " · " + dur(s.until * 1000 - now()) + " left" : ""}`;
    } else if (s.state === "Abroad") {
      cls = "a";
      text = "In " + (s.abroad || "?");
    } else if (s.state === "Okay") {
      cls = "g";
      text = "Okay";
    }
    return { dot, text, cls, la: la.ts ? ago(la.ts * 1000) : "" };
  }
  function renderWatch() {
    const ctx = profileContext();
    const ids = Object.keys(W).sort((a, b) => {
      const sa = W[a].s || {},
        sb = W[b].s || {};
      const on = (s) => (s.la && s.la.status === "Online" ? 0 : s.la && s.la.status === "Idle" ? 1 : 2);
      return on(sa) - on(sb) || (W[a].name || "").localeCompare(W[b].name || "");
    });
    ids.filter(needStats).forEach((id) => stats(id).then(renderSoon));
    body().innerHTML = `
      ${noKeyBox()}
      ${ctx && !W[ctx] && ctx !== myId ? `<button class="ctx" data-act="watchAdd" data-id="${ctx}">⭐ Watch this player <small>(#${ctx})</small></button>` : ""}
      <div class="addrow"><input class="addid" inputmode="numeric" placeholder="Player ID to watch"><button class="btn" data-act="watchAddInput">Add</button></div>
      <div class="list">${ids.length ? ids.map(watchRow).join("") : `<p class="muted hint">No one yet. Open a player's profile and tap ⭐ Watch, or type their ID above.</p>`}</div>
      ${ids.length ? `<p class="muted small foot">Checks each player every ${S.pollSec}s and their bazaar every ${S.bazaarMin} min while Torn is open. API calls this session: ${apiUsedTotal}${apiQueued() ? ` · ${apiQueued()} waiting` : ""}.</p>` : ""}`;
  }
  function watchRow(id) {
    const w = W[id];
    const b = statusBits(w.s);
    const trav = travelLine(w, "row");
    return `<button class="row" data-act="player" data-id="${id}">
      <span class="dot ${b.dot}"></span>
      <span class="nm">${esc(w.name || "#" + id)} <small>${w.level ? "Lv " + w.level + " · " : ""}${b.la ? "active " + b.la : ""}${w.err ? ` · <span class="r">${esc(w.err)}</span>` : ""}</small>
        ${trav ? `<small class="trav">${trav}</small>` : ""}</span>
      <span class="rt"><b class="${b.cls}">${esc(trav ? "Flying" : b.text)}</b><small>${statsChip(id)}</small></span>
    </button>`;
  }

  // ---------------------------------------------------------------- player detail
  function renderPlayer() {
    const id = view.id;
    const w = W[id];
    const p = DB[id] || {};
    const watched = !!w;
    if (needStats(id)) stats(id).then(() => view.name === "player" && view.id === id && renderSoon());
    if (S.tsKey && !view.spyBusy && (!ST[id] || !ST[id].spyT || now() - ST[id].spyT > DAY)) {
      view.spyBusy = true;
      tornStatsSpy(id).finally(() => {
        view.spyBusy = false;
        saveSoon("stats");
        if (view.name === "player" && view.id === id) renderSoon();
      });
    }
    if (!watched && (!p.pt || now() - p.pt > PROFILE_TTL) && apiKey() && !view.loading) {
      view.loading = true;
      getProfile(id, { hi: true })
        .catch((e) => toast(e.message, "bad"))
        .finally(() => {
          view.loading = false;
          if (view.name === "player" && view.id === id) render();
        });
    }
    const s = w ? w.s : p.st ? { state: p.st, la: p.la ? { ts: p.la } : null } : null;
    const b = statusBits(s);
    const st = ST[id] || {};
    const win = winOf(id);
    const co = p.co ? CO[p.co] : null;
    const est = w && w.trip ? tripEstimate(w) : null;
    const sold24 = salesIn(id, 24);
    const mugged = MUGGED[id];
    body().innerHTML = `
      <div class="phead">
        <div class="grow"><div class="iname">${esc((w && w.name) || p.n || "#" + id)} <small class="muted">[${id}]</small></div>
          <div class="small muted">${p.lv || (w && w.level) ? "Level " + (p.lv || w.level) : ""}${p.fn || (w && w.faction && w.faction.name) ? " · " + esc(p.fn || w.faction.name) : ""}</div></div>
        <button class="ib star ${watched ? "on" : ""}" data-act="${watched ? "watchDel" : "watchAdd"}" data-id="${id}" title="${watched ? "Stop watching" : "Watch"}">${watched ? "★" : "☆"}</button>
      </div>
      <div class="stats">
        <div class="stat"><span>Status</span><b class="${b.cls}">${esc(w && w.trip ? "Flying" : b.text)}</b><small>${b.la ? "Last action " + b.la : ""}</small></div>
        <div class="stat"><span>Win chance</span><b>${win.label}</b><small>${win.note || (win.r != null ? "their stats ≈ " + Math.round(win.r * 100) + "% of yours" : S.myTotal ? "" : "add your total stats in ⚙️ for a better guess")}</small></div>
        <div class="stat"><span>Est. battle stats</span><b>${st.spy ? num(st.spy.total) : st.bs ? st.bsh || num(st.bs) : "?"}</b><small>${st.spy ? `spy ${st.spy.at ? ago(st.spy.at * 1000) : ""}` : st.ff != null ? "FF " + st.ff.toFixed(2) + " (FF Scouter)" : ffErr ? esc(ffErr) : ""}</small></div>
        <div class="stat"><span>Job</span><b class="small">${p.cn ? esc(p.cn) : p.pos ? esc(p.pos) : "?"}</b><small>${p.ct ? esc(typeName(p.ct)) : ""}${co ? " · " + co.stars + "★" : ""}${p.pos && p.cn ? " · " + esc(p.pos) : ""}</small></div>
      </div>
      ${
        est && !est.unknown
          ? `<div class="box"><b>${travelLine(w, "page")}</b>
          ${!est.single ? `<div class="small muted">${est.known ? "If they flew" : "Latest landing if they flew"}: ${est.opts.map((o) => `${TICKETS[o.k]} ${est.known ? "~" + clock(o.mid) : "by " + clock(o.hi)}`).join(" · ")}</div>` : ""}
          <div class="small muted">${planeNote(w)}</div>
          ${
            !est.known || est.manual
              ? `<div class="tof"><div class="small">${est.manual ? "You entered when they took off. Change it:" : "Do you know when they took off? Enter it and the landing time is worked out from that."}</div>
            <div class="tof-row"><input class="tof-time" type="time" value="${w.trip && w.trip.manualClock ? esc(w.trip.manualClock) : ""}"><select class="tof-tz"><option value="local">your phone's time</option><option value="tct" ${w.trip && w.trip.manualTz === "tct" ? "selected" : ""}>Torn time (TCT)</option></select></div>
            <div class="tof-row"><span class="small">or took off</span><input class="tof-ago" type="number" inputmode="numeric" placeholder="min" min="0"><span class="small">minutes ago</span><button class="btn sm" data-act="tofSet" data-id="${id}">Use this</button>${est.manual ? `<button class="link small" data-act="tofClear" data-id="${id}">clear</button>` : ""}</div></div>`
              : ""
          }</div>`
          : ""
      }
      ${sold24 ? `<div class="box">💰 Sold about <b>${short(sold24)}</b> in the last 24h. ${mugLine(sold24, p.ct, co && co.stars)}</div>` : ""}
      ${mugged ? `<div class="box small">You marked this player as mugged ${ago(mugged)}. <button class="link" data-act="unmug" data-id="${id}">Undo</button></div>` : ""}
      <div class="row-btn">
        <a class="btn" href="${profileUrl(id)}">Profile</a>
        <a class="btn ghost" href="${attackUrl(id)}">Attack</a>
        <a class="btn ghost" href="${bazaarUrl(id)}">Bazaar</a>
        <button class="btn ghost" data-act="mugged" data-id="${id}">💰 I mugged them</button>
      </div>
      ${watched ? bazaarBox(w) : ""}
      ${watched ? `<h3>Log</h3><div class="log">${(w.log || []).length ? w.log.map((l) => `<div><span class="muted">${clock(l.t)} ${new Date(l.t).toLocaleDateString([], { day: "numeric", month: "short" })}</span> ${ICON[l.kind] || ""} ${esc(l.text)}</div>`).join("") : `<p class="muted small">Nothing yet. Changes show here and in 🔔 Feed.</p>`}</div>` : ""}
      ${watched ? `<label class="tog"><input type="checkbox" data-act="bzToggle" data-id="${id}" ${w.bazaar !== false ? "checked" : ""}> Check their bazaar (1 API call every ${S.bazaarMin} min)</label>` : ""}`;
  }
  function planeNote(w) {
    const t = w.trip || {};
    const bits = [];
    if (t.plane) {
      const pt = planeTicket(t.plane);
      bits.push(`Plane type from Torn: "${esc(t.plane)}"${pt ? ` → ${TICKETS[pt.k]} (${pt.how === "learned" ? "learned from real flights" : "a guess until a flight confirms it"})` : " (not matched to a ticket yet)"}.`);
    } else if (t.plane === null) bits.push("Torn didn't give a plane type for this flight.");
    if (w.ticket != null) bits.push(`Learned from a past flight: flies ${TICKETS[w.ticket]}.`);
    else bits.push("After one full flight I'll learn their usual ticket.");
    return bits.join(" ");
  }
  function bazaarBox(w) {
    if (w.bazaar === false) return "";
    const items = w.bz ? Object.values(w.bz.items) : null;
    if (!items) return `<h3>Bazaar</h3><p class="muted small">Not checked yet.</p>`;
    const tot = items.reduce((a, i) => a + i.q * i.p, 0);
    return `<h3>Bazaar <small class="muted">(${items.length} listings · ${short(tot)} · checked ${ago(w.bz.t)})</small></h3>
      <div class="mini-list">${items.length ? items.sort((a, b) => b.q * b.p - a.q * a.p).slice(0, 15).map((i) => `<div><span>${i.q}× ${esc(i.name)}</span><b>${short(i.p)}</b></div>`).join("") : `<p class="muted small">Empty or closed.</p>`}</div>`;
  }
  function mugLine(cash, ct, stars) {
    const r = mugRange(cash, ct, stars);
    if (!r) return "";
    return `If it's still on hand, a mug might get <b>${short(r[0])}–${short(r[1])}</b>${isClothing(ct) && stars >= 7 ? " (7★ clothing store cuts it by 75%)" : ""}.`;
  }

  // ---------------------------------------------------------------- Feed tab
  function renderFeed() {
    EVENTS.forEach((e) => (e.seen = true));
    saveSoon("events");
    updateBadge();
    body().innerHTML = `
      <div class="feedtop"><span class="muted small">${EVENTS.length} events</span><button class="btn ghost sm" data-act="feedClear">Clear</button></div>
      <div class="list">${
        EVENTS.length
          ? EVENTS.slice(0, 150)
              .map((e) => `<button class="row ev" data-act="player" data-id="${e.pid}"><span class="evi">${ICON[e.kind] || "👁️"}</span><span class="nm"><b>${esc(e.name)}</b> <span class="evt">${esc(e.text)}</span><small>${clock(e.t)} · ${ago(e.t)}</small></span></button>`)
              .join("")
          : `<p class="muted hint">No events yet. Watch some players and changes will show up here.</p>`
      }</div>`;
  }

  // ---------------------------------------------------------------- Hunt tab
  function renderHunt() {
    const mode = S.hunt;
    body().innerHTML = `
      ${noKeyBox()}
      <div class="sorts slim">
        <button class="seg ${mode === "live" ? "on" : ""}" data-act="hunt" data-mode="live">📡 Live sales</button>
        <button class="seg ${mode === "search" ? "on" : ""}" data-act="hunt" data-mode="search">🔎 Search</button>
      </div>
      <div class="hunt-form"></div>
      <div class="hunt-msg small muted"></div>
      <div class="cards results"></div>`;
    ({ live: liveForm, search: searchForm })[mode]();
    drawResults();
  }
  function setMsg(t) {
    view.msg = t;
    const m = $(".hunt-msg");
    // Live sales has its own status line; messages from the other tabs don't belong there.
    if (m) m.innerHTML = S.hunt === "live" ? "" : t;
  }
  function renderGrowMsg() {
    const m = $(".grow-msg");
    if (m) m.textContent = growMsg;
  }
  function bindForm(obj, onChange) {
    $$(".hunt-form [data-f]").forEach((el) =>
      el.addEventListener("change", () => {
        const k = el.dataset.f;
        obj[k] = el.type === "checkbox" ? el.checked : el.tagName === "SELECT" && el.multiple ? [...el.selectedOptions].map((o) => +o.value) : el.value;
        save();
        onChange && onChange();
      })
    );
  }

  // Result cards (shared by all three modes). view.results = [{ id, line, score, cash }]
  function resultCard(r) {
    const id = r.id;
    const p = DB[id] || {};
    const w = W[id];
    const s = w ? w.s : p.st ? { state: p.st, la: p.la ? { ts: p.la } : null } : null;
    const b = statusBits(s);
    const co = p.co ? CO[p.co] : null;
    return `<div class="card ${MUGGED[id] ? "dim" : ""}">
      <div class="crow">
        <div class="c1">
          <button class="link nmlink" data-act="player" data-id="${id}">${esc(p.n || (w && w.name) || "#" + id)}</button>
          <span class="small muted">[${id}]${p.lv ? " · Lv " + p.lv : ""}</span>
          <div class="small"><span class="${b.cls}">${esc(b.text)}</span>${p.la ? ` · <span class="muted">active ${ago(p.la * 1000)}</span>` : ""}</div>
          ${p.ct || p.cn ? `<div class="small muted">${esc(typeName(p.ct))}${co ? " " + co.stars + "★" : ""}${p.pos ? " · " + esc(p.pos) : ""}${isClothing(p.ct) && co && co.stars >= 7 ? ' · <span class="r">7★ clothing: −75% mug</span>' : ""}</div>` : ""}
          <div class="small">${r.line || ""}</div>
          <div class="small">${statsChip(id)}</div>
        </div>
        <div class="c2">
          <a class="btn sm" href="${attackUrl(id)}">Attack</a>
          <div class="c2b">
            <a class="ib sm" href="${profileUrl(id)}" title="Profile">👤</a>
            <button class="ib sm star ${w ? "on" : ""}" data-act="${w ? "watchDel" : "watchAdd"}" data-id="${id}" title="Watch">${w ? "★" : "☆"}</button>
            <button class="ib sm" data-act="mugged" data-id="${id}" title="I mugged them">💰</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  // Hunt results are saved on the phone, so they're still there after visiting the attack page.
  const SAVED_RES = store.get("results", {}); // mode -> { t, list, msg }
  function drawResults() {
    const box = $(".results");
    if (!box) return;
    if (!(view.results && view.results.mode === S.hunt)) {
      const sv = SAVED_RES[S.hunt];
      if (sv && now() - sv.t < 6 * HOUR) {
        view.results = { mode: S.hunt, list: sv.list };
        view.msg = sv.msg || "";
      }
    } else {
      SAVED_RES[S.hunt] = { t: now(), list: view.results.list.slice(0, 100), msg: view.msg || "" };
      saveResults();
    }
    setMsg(view.msg || "");
    const rs = view.results && view.results.mode === S.hunt ? view.results.list : null;
    if (!rs) {
      box.innerHTML = "";
      return;
    }
    const shown = rs.filter((r) => !r.hidden && !r.pending);
    box.innerHTML = shown.length ? shown.slice(0, 80).map(resultCard).join("") : `<p class="muted hint">${S.hunt === "sleep" ? "No sleeping workers found. See the report above." : "No players match. Try looser filters or tap 'Find more players'."}</p>`;
  }
  const saveResults = (() => {
    let t = 0;
    return () => {
      clearTimeout(t);
      t = setTimeout(() => store.set("results", SAVED_RES), 1000);
    };
  })();
  const drawSoon = (() => {
    let t = 0;
    return () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (isOpen() && view.name === "hunt") drawResults();
      }, 300);
    };
  })();

  // Look up profile (+ company) and stats for a list of results, in the background, and re-check filters.
  async function enrich(list, opts) {
    const runId = (view.runId = (view.runId || 0) + 1);
    const ids = list.map((r) => r.id);
    ids.forEach((id) => stats(id).then(drawSoon));
    let done = 0;
    for (const r of list) {
      if (view.runId !== runId) return;
      try {
        if (opts.profile) {
          const p = DB[r.id] || {};
          if (!p.pt || now() - p.pt > PROFILE_TTL) await getProfile(r.id, { hi: true });
          const q = DB[r.id] || {};
          if (opts.company && q.co && (!CO[q.co] || now() - CO[q.co].t > COMPANY_TTL)) await getCompany(q.co, { hi: true });
        }
      } catch (e) {
        r.err = e.message;
      }
      done++;
      if (opts.recheck) opts.recheck(r);
      setMsg(`${opts.label || "Checking"} ${done}/${list.length}${apiQueued() ? " · waiting for API limit" : ""}`);
      drawSoon();
    }
    if (view.runId === runId) {
      await Promise.all(ids.map((id) => stats(id)));
      if (opts.recheck) list.forEach(opts.recheck);
      if (opts.sort) opts.sort(list);
      setMsg(opts.done ? opts.done(list) : "Done.");
      drawSoon();
    }
  }

  // --- 📡 Live sales
  function liveForm() {
    const f = S.live;
    const n = Object.keys(POOL).length;
    const every = n ? Math.max(30, (n * 60) / Math.max(1, +f.calls || 25)) : 0;
    const chips = [500000, 1000000, 5000000, 10000000];
    $(".hunt-form").innerHTML = `
      <div class="livebar">
        <button class="btn ${f.running ? "ghost" : ""}" data-act="liveToggle">${f.running ? "⏸️ Pause" : "▶️ Start live"}</button>
        <span class="small livestat"></span>
      </div>
      <div class="chips">${chips.map((v) => `<button class="chip ${+f.min === v ? "on" : ""}" data-act="liveMin" data-v="${v}">${short(v)}+</button>`).join("")}
</div>
      <div class="filters two">
        <label>Min amount ($)<input data-lf="min" type="number" inputmode="numeric" placeholder="0" value="${esc(f.min)}"></label>
        <label>Max amount ($)<input data-lf="max" type="number" inputmode="numeric" placeholder="no max" value="${esc(f.max)}"></label>
      </div>
      <div class="filters">
        <label>Win chance<select data-lf="win"><option value="">Any</option><option value="easy" ${f.win === "easy" ? "selected" : ""}>🟢 Easy</option><option value="likely" ${f.win === "likely" ? "selected" : ""}>🟡 Likely+</option><option value="risky" ${f.win === "risky" ? "selected" : ""}>🟠 Risky+</option></select></label>
        <label>Item has<input data-lf="item" type="text" placeholder="any" value="${esc(f.item)}"></label>
        <label>Alert me at<input data-lf="alertMin" type="number" inputmode="numeric" placeholder="same as min" value="${esc(f.alertMin)}"></label>
      </div>
      <label class="tog"><input type="checkbox" data-lf="onlyAway" ${f.onlyAway ? "checked" : ""}> Only 🔥 away (offline since the sale, flying, or abroad outside Cayman)</label>
      <p class="muted small">Torn delays bazaar data on purpose (to slow down mug bots), so a sale shows up a little after it happens. The time shown is Torn's.</p>
      <div class="live-list cards"></div>
      <details class="more pool"><summary>Seller pool: ${n} players${every ? ` · each checked about every ${dur(every * SEC) === "0m" ? Math.round(every) + "s" : dur(every * SEC)}` : ""}</summary>
        <p class="muted small">Big sellers are checked one after another (1 API call each: their bazaar and status). The pool fills itself from Torn's weekly top-earning bazaars and big sellers found on TornW3B. Add anyone you like.</p>
        <div class="addrow"><input class="poolid" inputmode="numeric" placeholder="Player ID to add"><button class="btn" data-act="poolAdd">Add</button></div>
        <div class="filters two">
          <label>Pool size<input data-lf="poolMax" type="number" inputmode="numeric" value="${esc(f.poolMax)}"></label>
          <label>API calls/min for live<input data-lf="calls" type="number" inputmode="numeric" value="${esc(f.calls)}"></label>
        </div>
        <div class="row-btn"><button class="btn ghost" data-act="poolFill">Refill pool now</button><button class="btn ghost" data-act="scanNow">Scan TornW3B now</button><button class="btn ghost" data-act="liveClear">Clear sales list</button></div>
        <p class="muted small">TornW3B scan (no API key): ${S.salesScan ? `every ${S.salesScanMin} min` : "off in ⚙️"}. ${esc(w3bStatus)}</p>
        <div class="mini-list">${Object.entries(POOL)
          .sort((a, b) => (b[1].val || 0) - (a[1].val || 0))
          .map(([id, m]) => `<div><span>${esc(m.n || "#" + id)}${m.manual ? " ⭐" : ""} <small class="muted">${m.val ? short(m.val) + " listed" : ""}${m.err ? " · " + esc(m.err) : ""}</small></span><button class="link" data-act="poolDel" data-id="${id}">remove</button></div>`)
          .join("")}</div>
      </details>`;
    $$(".hunt-form [data-lf]").forEach((el) =>
      el.addEventListener("change", () => {
        const k = el.dataset.lf;
        f[k] = el.type === "checkbox" ? el.checked : el.value;
        if (["poolMax", "calls"].includes(k)) f[k] = Math.max(1, Math.min(k === "calls" ? 100 : 200, +el.value || DEFAULTS.live[k]));
        save();
        if (k === "min") $$(".chip[data-act=liveMin]").forEach((c) => c.classList.toggle("on", +c.dataset.v === +f.min));
        if (k === "max" && el.value === "") f.max = "";
        drawLive();
      })
    );
    drawLive();
  }

  const awayText = (row, m) => {
    const a = awayNow(m);
    if (a) return a;
    return row.away === "offline" && m && m.la ? `offline ${ago(m.la * 1000).replace(" ago", "")}` : row.away || "";
  };
  function drawLive() {
    const box = $(".live-list");
    if (!box) return;
    const f = S.live;
    const st = $(".livestat");
    const n = Object.keys(POOL).length;
    if (st) st.innerHTML = f.running ? `<span class="g">● Live</span> · ${n} sellers${liveLast ? ` · last check ${clock(liveLast)}` : ""}${apiQueued() ? " · waiting for API limit" : ""}` : `<span class="muted">Paused</span>`;
    const min = +f.min || 0;
    const max = +f.max || 0; // 0 = no maximum
    let noStats = 0;
    const all = LIVE.filter((r) => {
      const hot = isHot(r);
      if (f.onlyAway && !hot) return false;
      // The amount that matters: the sale, or for 🔥 sellers everything unbanked since they were last seen.
      const amt = hot ? Math.max(r.v, unbanked(r.pid)) : r.v;
      if (amt < min) return false;
      if (max && amt > max) return false;
      if (f.item && !r.item.toLowerCase().includes(f.item.toLowerCase())) return false;
      if (f.win) {
        const k = winOf(r.pid).k;
        if (k === "unk") noStats++;
        if (WIN_ORDER[k] > WIN_ORDER[f.win]) return false;
      }
      return true;
    });
    const rows = all.slice(0, 100);
    const missing = [...new Set(LIVE.slice(0, 150).map((r) => r.pid))].filter(needStats);
    if (missing.length) missing.forEach((pid) => stats(pid).then(drawLiveSoon));
    // Say exactly which filters are on, so it's clear what is being used.
    const winLbl = { easy: "🟢 Easy", likely: "🟡 Likely or better", risky: "🟠 Risky or better" }[f.win];
    const on = [max ? `sales of ${short(min)} to ${short(max)}` : `sales of ${short(min)} or more`, f.onlyAway ? "🔥 away only" : "", winLbl ? winLbl + " only" : "", f.item ? `item has "${esc(f.item)}"` : ""].filter(Boolean);
    const sum = `<p class="small livesum">Showing <b>${all.length}</b> of ${LIVE.length} sales · ${on.join(" · ")}${noStats ? ` · <span class="a">${noStats} hidden because their stats haven't loaded${ffErr ? ` (${esc(ffErr)})` : ""}</span>` : ""}</p>`;
    box.innerHTML =
      sum +
      (rows.length
        ? rows.map(liveRow).join("")
        : `<p class="muted hint">${LIVE.length ? "No sales match these filters yet." : f.running ? "Watching… sales show up here the moment they're spotted." : "Tap ▶️ Start live. Sales show up here the moment they're spotted."}</p>`);
  }
  function liveRow(r) {
    const m = sellerOf(r.pid);
    const hot = isHot(r);
    const banked = isBanked(r, m);
    const total = hot ? unbanked(r.pid) : 0;
    const d = DB[r.pid] || {};
    const mr = hot ? mugRange(total * learnFactor("live").f, d.ct, d.co && CO[d.co] ? CO[d.co].stars : 0) : null;
    let status;
    if (r.pending) status = `<span class="muted">checking status…</span>`;
    else if (!r.away) status = `<span class="muted">was around for the sale, probably banked</span>`;
    else if (banked) status = `<span class="muted">came back ${m && m.la ? ago(m.la * 1000) : ""}, probably banked</span>`;
    else if (hot) status = `<span class="hot">🔥 ${esc(awayText(r, m))}</span>${total > r.v ? ` · unbanked ~<b>${short(total)}</b>` : ""}${mr ? ` · mug ~${short(mr[0])}–${short(mr[1])}${learnedNote("live")}` : ""}`;
    else status = `<span class="muted">${m && m.on === "Online" ? "online" : m && m.on ? "active " + ago(m.la * 1000) : ""}</span>`;
    return `<div class="card lrow ${hot ? "hotrow" : ""} ${banked ? "dim" : ""}">
      <div class="crow">
        <div class="c1">
          <div><span class="muted small" title="Time of Torn's bazaar data">${new Date(r.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <button class="link nmlink" data-act="player" data-id="${r.pid}">${esc((m && m.n) || d.n || "#" + r.pid)}</button></div>
          <div class="small">sold ${r.q}× ${esc(r.item)} <b>${short(r.v)}</b>${r.src === "w3b" ? ' <span class="muted">(TornW3B)</span>' : ""}</div>
          <div class="small">${status}</div>
          <div class="small">${statsChip(r.pid)}</div>
        </div>
        <div class="c2">${hot ? `<a class="btn sm" href="${attackUrl(r.pid)}">Attack</a>` : `<a class="ib sm" href="${profileUrl(r.pid)}" title="Profile">👤</a>`}</div>
      </div>
    </div>`;
  }
  const drawLiveSoon = (() => {
    let t = 0;
    return () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (isOpen() && view.name === "hunt" && S.hunt === "live") drawLive();
      }, 200);
    };
  })();

  // --- Company scan (used by Search when company types are picked)
  // Reads the companies of the chosen types and saves every worker (with last action and job),
  // so Search can filter them like any other player. Companies are cached for 6 hours.
  async function scanCompanies(f, runId) {
    let cos = [];
    for (const t of f.ctypes) {
      // Torn returns 100 companies per call, so page through (up to 5 pages per type).
      for (let off = 0; off < 500; off += 100) {
        setMsg(`Loading ${esc(typeName(t))} companies… ${off ? off + "+" : ""}`);
        const d = await torn(`/company/${t}?selections=companies&limit=100&offset=${off}`, 6 * HOUR, { hi: true });
        const rows = Object.entries(d.company || d.companies || {});
        for (const [cid, c] of rows) cos.push({ cid: +(c.ID || cid), stars: +c.rating || 0, inc: +c.daily_income || 0, emp: +c.employees_hired || 0 });
        if (rows.length < 100) break;
      }
    }
    const listed = cos.length;
    cos = cos.filter((c) => c.stars >= (numOr(f.starsMin) || 0) && (numOr(f.starsMax) == null || c.stars <= +f.starsMax) && c.emp > 0).sort((a, b) => b.inc / b.emp - a.inc / a.emp || b.stars - a.stars);
    const want = Math.max(1, Math.min(200, +f.companies || 40));
    // Top companies fire inactive staff fast, so by default spread the picks across the whole list.
    if (f.pick === "top" || cos.length <= want) cos = cos.slice(0, want);
    else {
      const step = cos.length / want;
      cos = Array.from({ length: want }, (_, k) => cos[Math.floor(k * step)]);
    }
    let i = 0,
      failed = 0,
      lastErr = "",
      workers = 0;
    for (const c of cos) {
      if (view.runId !== runId) return null;
      i++;
      setMsg(`Reading companies ${i}/${cos.length}${apiQueued() ? " · waiting for API limit" : ""}`);
      try {
        const co = await getCompany(c.cid, { hi: true });
        workers += Object.keys(co.emps || {}).length;
      } catch (e) {
        failed++;
        lastErr = e.message;
      }
    }
    return { listed, checked: cos.length - failed, workers, failed, lastErr };
  }
  // Rough pay piled up while inactive (wages land as cash on hand).
  function unbankedPay(p) {
    const co = p.co ? CO[p.co] : null;
    const inact = daysSince(p.la);
    if (!co || !co.emp || inact == null || inact < 1) return null;
    const wage = ((co.inc / Math.max(1, co.emp)) * (+S.wageShare || 30)) / 100;
    const raw = Math.min(inact, p.dic || inact) * wage;
    return { days: inact, paid: Math.min(inact, p.dic || inact), raw, cash: raw * learnFactor("worker").f, co };
  }

  // ---------------------------------------------------------------- Learning from your mugs
  // When you open an attack from the script, it remembers what it guessed the target was holding.
  // When the mug result shows up (on the attack page you're looking at, or in your events with a
  // Limited key), it works out the cash they really had and keeps a running correction per kind
  // of target: "worker" (unbanked pay guess) and "live" (sales made while away).
  const LEARN = store.get("learn", { worker: [], live: [], log: [], pending: {}, evT: 0 });
  const saveLearn = () => store.set("learn", LEARN);
  const MIN_SAMPLES = 3;
  function learnFactor(src) {
    const xs = (LEARN[src] || []).slice(-15);
    if (xs.length < MIN_SAMPLES) return { f: 1, n: xs.length };
    const sorted = [...xs].sort((a, b) => a - b);
    return { f: sorted[Math.floor(sorted.length / 2)], n: xs.length }; // median: one odd mug can't swing it
  }
  const learnedNote = (src) => {
    const L = learnFactor(src);
    return L.n >= MIN_SAMPLES ? ` <span class="muted">(learned from ${L.n} mugs)</span>` : "";
  };
  // What the script would guess right now for this player, before learning: { src, raw }.
  function rawGuess(pid) {
    const away = unbanked(pid);
    if (away > 0) return { src: "live", raw: away };
    const up = unbankedPay(DB[pid] || {});
    if (up && up.days >= 2) return { src: "worker", raw: up.raw };
    return null;
  }
  function rememberAttack(pid) {
    pid = +pid;
    if (!pid) return;
    const g = rawGuess(pid);
    LEARN.pending[pid] = { t: now(), src: g ? g.src : "", raw: g ? g.raw : 0, name: (DB[pid] && DB[pid].n) || (W[pid] && W[pid].name) || "" };
    for (const [k, v] of Object.entries(LEARN.pending)) if (now() - v.t > 3 * HOUR) delete LEARN.pending[k];
    saveLearn();
  }
  function mugPctMid(pid) {
    const p = DB[pid] || {};
    const co = p.co ? CO[p.co] : null;
    const r = mugRange(1, p.ct, co ? co.stars : 0);
    return r ? (r[0] + r[1]) / 2 : 0.075;
  }
  function recordMug(pid, amount, how) {
    pid = +pid;
    amount = Math.round(+amount || 0);
    if (!pid || !amount) return;
    const key = pid + ":" + amount;
    if (LEARN.log.some((l) => l.key === key && now() - l.t < 6 * HOUR)) return; // seen already (page + events)
    const pend = LEARN.pending[pid];
    const cash = amount / mugPctMid(pid);
    const entry = { key, t: now(), pid, name: (pend && pend.name) || (DB[pid] && DB[pid].n) || "#" + pid, amount, cash, how, src: pend ? pend.src : "", guess: pend ? pend.raw : 0 };
    if (pend && pend.src && pend.raw > 0) {
      const ratio = Math.max(0.001, Math.min(100, cash / pend.raw));
      LEARN[pend.src] = [...(LEARN[pend.src] || []), ratio].slice(-15);
      entry.ratio = ratio;
    }
    delete LEARN.pending[pid];
    LEARN.log = [entry, ...LEARN.log].slice(0, 20);
    saveLearn();
    MUGGED[pid] = now();
    saveSoon("mugged");
    toast(`💰 Mug of ${short(amount)} noted${entry.ratio ? ". Guesses adjusted" : ""}`, "ok", 3500);
  }

  // Attack page (only while you're looking at it): "...mugged NAME for $29,511" or similar.
  let atkTimer = 0;
  function scanAttackPage() {
    if (document.hidden || !/sid=attack/i.test(location.href)) return;
    const pid = +((location.href.match(/user2ID=(\d+)/i) || [])[1] || 0);
    if (!pid) return;
    const txt = (document.body.innerText || "").replace(/\s+/g, " ");
    const m = txt.match(/\bmugg(?:ed|ing)\b[^$]{0,80}\$\s?([\d,]{1,15})/i) || txt.match(/\$\s?([\d,]{1,15})[^$]{0,40}\bmugg/i);
    if (m) recordMug(pid, +m[1].replace(/,/g, ""), "attack page");
  }

  // Events (needs a Limited key): "...attacking <a href=...XID=123>name</a> and mugged them for $29,511"
  let evBusy = false;
  async function checkMugEvents(force) {
    if (evBusy || document.hidden) return;
    const pend = Object.keys(LEARN.pending).length;
    if (!force && !pend) return;
    if (!force && now() - (LEARN.evT || 0) < 2 * MIN) return;
    const key = (S.eventsKey || "").trim() || apiKey();
    if (!key) return;
    evBusy = true;
    LEARN.evT = now();
    try {
      const d = await torn(`/user/?selections=events`, 60 * SEC, { key });
      let evs = d.events || {};
      evs = Array.isArray(evs) ? evs : Object.values(evs);
      LEARN.evErr = "";
      for (const e of evs) {
        const text = String(e.event || "");
        const ts = (+e.timestamp || 0) * 1000;
        if (now() - ts > 6 * HOUR) continue;
        const m = text.match(/XID=(\d+)[\s\S]*?mugged them for \$([\d,]+)/i);
        if (m) recordMug(+m[1], +m[2].replace(/,/g, ""), "events");
      }
    } catch (e) {
      LEARN.evErr = /access level/i.test(e.message) ? "Events need a Limited key (add it in ⚙️ Settings)." : e.message;
    } finally {
      evBusy = false;
      saveLearn();
    }
  }

  // --- 🔎 Search (your own advanced search)
  function searchForm() {
    const f = S.search;
    const types = (CTYPES && CTYPES.types) || {};
    const n = Object.keys(DB).length;
    const inp = (k, ph, mode = "numeric") => `<input data-f="${k}" ${mode === "numeric" ? 'type="number" inputmode="numeric"' : 'type="text"'} placeholder="${ph}" value="${esc(f[k])}">`;
    // Quick buttons: Oil Rig, Mining Corporation, plus anything already picked.
    const quick = Object.entries(types).filter(([id, nm]) => /oil rig|mining/i.test(nm) || f.ctypes.includes(+id));
    $(".hunt-form").innerHTML = `
      <div class="cbox">
        <div class="cbox-h">🏢 <b>Company workers</b> <span class="muted small">(optional) find inactive workers whose pay piles up as cash</span></div>
        <div class="chips">${quick
          .map(([id, nm]) => `<button class="chip ${f.ctypes.includes(+id) ? "on" : ""}" data-act="sctype" data-id="${id}">${esc(nm)}</button>`)
          .join("")}</div>
        <div class="small cpicked">${f.ctypes.length ? "Picked: <b>" + f.ctypes.map((t) => esc(typeName(t))).join(", ") + "</b>" : "None picked: searching your saved players only."}</div>
        <details class="more ctypes"><summary>All company types and options</summary>
          <p class="muted small">Search reads the picked companies' worker lists first (1 API call per company, saved for 6 hours), adds the workers, then applies your filters. Each worker shows a guess of their unbanked pay.</p>
          <div class="chips">${Object.entries(types)
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([id, nm]) => `<button class="chip ${f.ctypes.includes(+id) ? "on" : ""}" data-act="sctype" data-id="${id}">${esc(nm)}</button>`)
            .join("")}</div>
          <div class="filters two">
            <label>Companies to read<input data-f="companies" type="number" inputmode="numeric" value="${esc(f.companies)}"></label>
            <label>Which companies<select data-f="pick"><option value="mix" ${f.pick !== "top" ? "selected" : ""}>Mix (all sizes)</option><option value="top" ${f.pick === "top" ? "selected" : ""}>Best pay first</option></select></label>
          </div>
        </details>
      </div>
      <div class="filters two">
        <label>Name has${inp("name", "any", "text")}</label>
        <label>Faction (name or ID)${inp("faction", "any", "text")}</label>
      </div>
      <div class="filters four">
        <label>Level from${inp("lvlMin", "1")}</label><label>to${inp("lvlMax", "100")}</label>
        <label>Inactive days from${inp("inMin", "0")}</label><label>to${inp("inMax", "any")}</label>
        <label>Days old from${inp("ageMin", "any")}</label><label>to${inp("ageMax", "any")}</label>
        <label>Offences from${inp("offMin", "any")}</label><label>to${inp("offMax", "any")}</label>
      </div>
      <div class="filters">
        <label>Networth at least${inp("nwMin", "any")}</label>
        <label>Max battle stats${inp("maxStats", "any")}</label>
        <label>Win chance<select data-f="win"><option value="">Any</option><option value="easy" ${f.win === "easy" ? "selected" : ""}>🟢 Easy</option><option value="likely" ${f.win === "likely" ? "selected" : ""}>🟡 Likely+</option><option value="risky" ${f.win === "risky" ? "selected" : ""}>🟠 Risky+</option></select></label>
        <label>Gender<select data-f="gender"><option value="">Any</option>${["Male", "Female", "Enby"].map((g) => `<option ${f.gender === g ? "selected" : ""}>${g}</option>`).join("")}</select></label>
        <label>Property has${inp("property", "any", "text")}</label>
        <label>Stars from${inp("starsMin", "0")}</label><label>Stars to${inp("starsMax", "10")}</label>
        <label>Sort<select data-f="sort">${[
          ["score", "Best target"],
          ["inactive", "Inactive longest"],
          ["nw", "Networth"],
          ["level", "Level (low)"],
          ["stats", "Weakest"],
          ["unbanked", "Most unbanked pay"],
        ]
          .map(([v, l]) => `<option value="${v}" ${f.sort === v ? "selected" : ""}>${l}</option>`)
          .join("")}</select></label>
      </div>
      <label class="tog"><input type="checkbox" data-f="okOnly" ${f.okOnly ? "checked" : ""}> Only Okay (not hospital, jail or flying)</label>
      <label class="tog"><input type="checkbox" data-f="noClothing" ${f.noClothing ? "checked" : ""}> Hide 7★+ clothing store workers (−75% mug)</label>
      <label class="tog">Hide players I mugged in the last<input class="num" data-f="hideMugged" type="number" inputmode="numeric" value="${esc(f.hideMugged)}"> days</label>
      <label class="tog">Check details of the top<input class="num" data-f="check" type="number" inputmode="numeric" value="${esc(f.check)}"> results</label>
      <div class="row-btn"><button class="btn" data-act="searchGo">Search</button><button class="btn ghost" data-act="grow" ${growBusy ? "disabled" : ""}>➕ Find more players</button><button class="btn ghost" data-act="searchReset">Reset filters</button></div>
      <p class="muted small">Searching <b>${n.toLocaleString()}</b> players saved on this phone. 'Find more players' uses ${S.grow.calls} API calls and adds up to ${S.grow.calls * 100} from the Hall of Fame and faction lists. <span class="grow-msg">${esc(growMsg)}</span></p>`;
    bindForm(f);
    if (!CTYPES && apiKey()) companyTypes().then(() => S.hunt === "search" && view.name === "hunt" && !root.activeElement && searchForm()).catch(() => {});
  }

  // Which filters need a profile or company lookup (one API call each).
  function needsProfile(f) {
    return !!(f.ageMin || f.ageMax || f.gender || f.property || f.starsMin || f.starsMax || f.noClothing || f.okOnly);
  }
  // Returns "" when the player passes the quick filters, or the name of the first filter that ruled them out.
  function cheapFail(id, p, f) {
    const L = numOr;
    if (f.name && !(p.n || "").toLowerCase().includes(f.name.toLowerCase())) return "name";
    if (f.faction) {
      const q = f.faction.trim().toLowerCase();
      if (/^\d+$/.test(q) ? +q !== p.f : !(p.fn || "").toLowerCase().includes(q)) return "faction";
    }
    // Level may be unknown (company worker lists don't include it); the player check fills it in.
    if (L(f.lvlMin) != null && p.lv != null && p.lv < +f.lvlMin) return "level";
    if (L(f.lvlMax) != null && p.lv != null && p.lv > +f.lvlMax) return "level";
    const inact = daysSince(p.la);
    if (L(f.inMin) != null && (inact == null || inact < +f.inMin)) return "inactive days";
    if (L(f.inMax) != null && (inact == null || inact > +f.inMax)) return "inactive days";
    if (L(f.nwMin) != null && (p.nw == null || p.nw < +f.nwMin)) return "networth (only known for Hall of Fame players)";
    if (L(f.offMin) != null && (p.off == null || p.off < +f.offMin)) return "offences (only known for Hall of Fame players)";
    if (L(f.offMax) != null && p.off != null && p.off > +f.offMax) return "offences";
    if (+f.hideMugged > 0 && MUGGED[id] && now() - MUGGED[id] < +f.hideMugged * DAY) return "mugged recently";
    if (f.ctypes && f.ctypes.length && !f.ctypes.includes(+p.ct)) return "company type";
    if (f.okOnly && p.st && p.st !== "Okay" && now() - (p.t || 0) < HOUR) return "not Okay";
    return "";
  }
  const matchCheap = (id, p, f) => !cheapFail(id, p, f);
  // Returns true (pass), false (fail) or null (still waiting for data).
  // Returns true (pass), false (fail) or null (still waiting for data).
  // Anything we already know fails wins over anything we're still waiting for.
  function statFail(id, f) {
    const s = ST[id];
    if (!s) return null;
    const bs = s.spy ? s.spy.total : s.bs;
    if (numOr(f.maxStats) != null && bs != null && bs > +f.maxStats) return true;
    if (f.win && WIN_ORDER[winOf(id).k] > WIN_ORDER[f.win]) return true;
    return false;
  }
  function matchSlow(id, p, f, why) {
    const L = numOr;
    const no = (r) => {
      if (why) why[r] = (why[r] || 0) + 1;
      return false;
    };
    let wait = false;
    if (f.maxStats || f.win) {
      const sf = statFail(id, f);
      if (sf === true) return no("battle stats / win chance");
      if (sf === null) wait = true;
    }
    if ((needsProfile(f) || ((L(f.lvlMin) != null || L(f.lvlMax) != null) && p.lv == null)) && !p.pt) return null;
    if (L(f.lvlMin) != null && (p.lv == null || p.lv < +f.lvlMin)) return no("level");
    if (L(f.lvlMax) != null && (p.lv == null || p.lv > +f.lvlMax)) return no("level");
    if (f.okOnly && p.st && p.st !== "Okay") return no("not Okay right now");
    if (L(f.ageMin) != null && (p.age == null || p.age < +f.ageMin)) return no("days old");
    if (L(f.ageMax) != null && (p.age == null || p.age > +f.ageMax)) return no("days old");
    if (f.gender && p.g !== f.gender) return no("gender");
    if (f.property && !(p.pr || "").toLowerCase().includes(f.property.toLowerCase())) return no("property");
    if (f.ctypes && f.ctypes.length && !f.ctypes.includes(+p.ct)) return no("company type");
    const co = p.co ? CO[p.co] : null;
    if ((L(f.starsMin) != null || L(f.starsMax) != null || f.noClothing) && p.co && !co) return null;
    const stars = co ? co.stars : null;
    if (L(f.starsMin) != null && (stars == null || stars < +f.starsMin)) return no("company stars");
    if (L(f.starsMax) != null && stars != null && stars > +f.starsMax) return no("company stars");
    if (f.noClothing && isClothing(p.ct) && stars >= 7) return no("7★ clothing store");
    return wait ? null : true;
  }
  function targetScore(id, p) {
    // Higher = better target: inactive, weak, rich, recently sold.
    const inact = Math.min(60, daysSince(p.la) || 0);
    const w = winOf(id);
    const winPts = { easy: 40, likely: 25, risky: 5, unk: 10, avoid: -40 }[w.k];
    const up = unbankedPay(p);
    const rich = Math.log10(1 + (p.nw || 0) / 1e6) * 10 + Math.log10(1 + salesIn(id, 48) / 1e5) * 10 + (up ? Math.log10(1 + up.cash / 1e5) * 10 : 0);
    return inact + winPts + rich;
  }
  async function searchGo() {
    const f = S.search;
    const runId = (view.runId = (view.runId || 0) + 1);
    let scanNote = "";
    if (f.ctypes.length) {
      if (!apiKey()) return toast("Add an API key first", "bad");
      view.results = { mode: "search", list: [] };
      let sc;
      try {
        sc = await scanCompanies(f, runId);
      } catch (e) {
        setMsg(`<span class="r">Couldn't read companies: ${esc(e.message)}</span>`);
        return;
      }
      if (!sc) return;
      scanNote = `Read ${sc.checked} of ${sc.listed} ${f.ctypes.map(typeName).join(" / ")} companies (${sc.workers} workers)${sc.failed ? ` · <span class="r">${sc.failed} failed: ${esc(sc.lastErr)}</span>` : ""}. `;
      if (!sc.workers && !sc.failed) scanNote += `<span class="r">Torn sent no worker lists.</span> `;
    }
    const why = {};
    const all = Object.entries(DB).filter(([id, p]) => {
      const r = cheapFail(+id, p, f);
      if (r) why[r] = (why[r] || 0) + 1;
      return !r;
    });
    if (!all.length) {
      view.results = { mode: "search", list: [] };
      const total = Object.keys(DB).length;
      view.msg = scanNote + (total
        ? `None of your <b>${total.toLocaleString()}</b> saved players pass the filters. Ruled out by: ${Object.entries(why)
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `<b>${esc(k)}</b> ${n.toLocaleString()}`)
            .join(" · ")}. <button class="link" data-act="searchReset">Reset filters</button>`
        : "Your players list is empty. Tap '➕ Find more players' first.");
      drawResults();
      return;
    }
    let list = all.map(([id, p]) => ({ id: +id, score: targetScore(+id, p) }));
    // Stats come from FF Scouter, 100 players per request, without using Torn API calls.
    // Get them first, so players who are too strong never take a place in the list.
    if (f.win || f.maxStats || f.sort === "stats") {
      list.sort((a, b) => b.score - a.score);
      const pool = list.slice(0, 500);
      view.results = { mode: "search", list: [] };
      view.msg = `${scanNote}${all.length.toLocaleString()} match the quick filters. Getting battle stats for ${pool.length}…`;
      drawResults();
      await Promise.all(pool.map((r) => stats(r.id)));
      if (view.runId !== runId) return;
      const before = pool.length;
      list = pool.filter((r) => statFail(r.id, f) !== true && !(f.win && !ST[r.id]));
      list.forEach((r) => (r.score = targetScore(r.id, DB[r.id] || {})));
      if (!list.length) {
        view.results = { mode: "search", list: [] };
        view.msg = `${scanNote}${all.length.toLocaleString()} match the quick filters, but none of the ${before} checked pass the battle stats / win chance filter${ffErr ? ` (${esc(ffErr)})` : ""}. Try 'Find more players' or a looser win chance.`;
        drawResults();
        return;
      }
    }
    const sorters = {
      score: (a, b) => b.score - a.score,
      inactive: (a, b) => (DB[a.id].la || 9e9) - (DB[b.id].la || 9e9),
      nw: (a, b) => (DB[b.id].nw || 0) - (DB[a.id].nw || 0),
      level: (a, b) => (DB[a.id].lv || 999) - (DB[b.id].lv || 999),
      stats: (a, b) => statOf(a.id) - statOf(b.id),
      unbanked: (a, b) => ((unbankedPay(DB[b.id] || {}) || {}).cash || 0) - ((unbankedPay(DB[a.id] || {}) || {}).cash || 0),
    };
    const sorter = () => list.sort(sorters[f.sort] || sorters.score);
    sorter();
    const top = list.slice(0, Math.max(5, Math.min(100, +f.check || 25)));
    const line = (r) => {
      const p = DB[r.id] || {};
      const bits = [];
      if (p.nw) bits.push("Networth " + short(p.nw));
      if (p.off) bits.push(p.off.toLocaleString() + " offences");
      if (p.age) bits.push(p.age + " days old");
      const sold = salesIn(r.id, 48);
      if (sold) bits.push("sold ~" + short(sold) + " in 48h");
      if (p.ml && now() - p.mlt < DAY) bits.push("listed " + short(p.ml) + " on Item Market");
      const up = unbankedPay(p);
      if (up && up.days >= 2) {
        const mLo = mugRange(up.cash * 0.5, up.co.type, up.co.stars),
          mHi = mugRange(up.cash * 1.5, up.co.type, up.co.stars);
        bits.unshift(`😴 Inactive <b>${Math.floor(up.days)}d</b> at ${esc(up.co.n || "")} (${up.co.stars}★)${up.paid < up.days ? ` · hired ${Math.floor(up.paid)}d ago` : ""} · est. unbanked pay ~<b>${short(up.cash * 0.5)}–${short(up.cash * 1.5)}</b>${mLo ? ` · mug ~${short(mLo[0])}–${short(mHi[1])}` : ""}${learnedNote("worker")}<br>`);
      }
      return bits.join(" · ").replace("<br> · ", "<br>");
    };
    const recheck = (r) => {
      const p = DB[r.id] || {};
      const ok = matchCheap(r.id, p, f) && matchSlow(r.id, p, f);
      r.hidden = ok === false;
      r.pending = ok === null;
      r.score = targetScore(r.id, p);
      r.line = line(r) + (r.pending ? ' <span class="muted">· checking…</span>' : "") + (r.err ? ` <span class="r">· ${esc(r.err)}</span>` : "");
    };
    top.forEach(recheck);
    view.results = { mode: "search", list: top };
    view.msg = `${scanNote}${all.length.toLocaleString()} match the quick filters. Checking the top ${top.length}…`;
    drawResults();
    $(".hunt-msg").scrollIntoView({ behavior: "smooth", block: "start" });
    enrich(top, {
      profile: true,
      company: !!(f.starsMin || f.starsMax || f.noClothing),
      recheck,
      label: `${all.length.toLocaleString()} match. Checking`,
      sort: (l) => l.sort(sorters[f.sort] || sorters.score),
      done: (l) => {
        const ok = l.filter((r) => !r.hidden && !r.pending).length;
        const w = {};
        l.forEach((r) => matchCheap(r.id, DB[r.id] || {}, f) && matchSlow(r.id, DB[r.id] || {}, f, w));
        const ruled = Object.entries(w)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `<b>${esc(k)}</b> ${n}`)
          .join(" · ");
        const tip = f.ctypes.length ? " Try more companies to read, 'Mix (all sizes)', or fewer inactive days." : "";
        return `${scanNote}${ok} of the top ${l.length} pass every filter (${all.length.toLocaleString()} matched the quick filters).${ruled ? " Ruled out by: " + ruled + "." : ""}${!ok ? tip : ""}`;
      },
    });
  }
  function statOf(id) {
    const s = ST[id];
    return s ? (s.spy ? s.spy.total : s.bs || 9e15) : 9e15;
  }

  // ---------------------------------------------------------------- Settings
  // API Terms of Service table, as Torn asks every tool to show where the key is entered.
  function tosTable() {
    const rows = [
      ["Data storage", "Only locally (on this phone, in the browser's storage)"],
      ["Data sharing", "Nobody. Player IDs you look up go to FF Scouter for stat estimates (if turned on)"],
      ["Purpose of use", "Competitive advantage: tracking players and finding mug targets (players holding cash after bazaar / Item Market sales, inactive workers)"],
      ["Key storage & sharing", "Stored locally / Shared with FF Scouter (stat estimates, can be turned off)"],
      ["Key access level", "Public. Limited is only used, if you have it, to read your own battle stats and your own events (mug results)"],
    ];
    return `<details class="more tos"><summary>API key terms of use (Torn ToS)</summary><table class="tos-t">${rows.map(([a, b]) => `<tr><th>${a}</th><td>${b}</td></tr>`).join("")}</table></details>`;
  }
  function learnBox() {
    const w = learnFactor("worker"),
      l = learnFactor("live");
    const fmt = (x, name) => (x.n >= MIN_SAMPLES ? `${name} guesses × <b>${x.f < 0.1 ? x.f.toFixed(3) : x.f.toFixed(2)}</b> (from ${x.n} mugs)` : `${name}: learning (${x.n}/${MIN_SAMPLES} mugs)`);
    return `<p class="small">${fmt(w, "Worker pay")} · ${fmt(l, "Live sales")}</p>
      <p class="muted small">Open attacks with the script's Attack button. After the mug, the amount is read from the attack page${(S.eventsKey || "").trim() ? " and your events" : " (add a Limited key above to also read your events)"}, and the guesses adjust by themselves.${LEARN.evErr ? ` <span class="r">${esc(LEARN.evErr)}</span>` : ""}</p>
      ${LEARN.log.length ? `<div class="mini-list">${LEARN.log
        .slice(0, 8)
        .map((g) => `<div><span>${esc(g.name)} <small class="muted">${ago(g.t)} · ${esc(g.how)}${g.guess ? ` · guessed ~${short(g.guess)}, had ~${short(g.cash)}` : ""}</small></span><b>${short(g.amount)}</b></div>`)
        .join("")}</div>` : ""}
      <div class="row-btn"><button class="btn ghost" data-act="evCheck">Check my events now</button><button class="btn ghost" data-act="learnReset">Reset learning</button></div>`;
  }
  function renderSettings() {
    const key = apiKey();
    const al = (k, label) => `<label class="tog"><input type="checkbox" data-al="${k}" ${S.alerts[k] ? "checked" : ""}> ${label}</label>`;
    const numIn = (k, label, extra = "") => `<label class="tog">${label}<input class="num" data-n="${k}" type="number" inputmode="numeric" value="${esc(S[k])}" ${extra}></label>`;
    body().innerHTML = `
      <div class="form">
        <label class="blk">Torn API key <small class="muted">(Public is enough)</small>
          <input class="key" data-k="apiKey" type="password" autocomplete="off" placeholder="${!S.apiKey && key ? "using Torn PDA key" : "16 characters"}" value="${esc(S.apiKey)}">
        </label>
        <p class="muted small">${PDA_KEY.includes("#") ? "" : "In Torn PDA your key is used automatically if this is empty. "}${deadKey && deadKey === key ? `<span class="r">This key stopped working (${esc(deadKeyMsg)}). Enter a working key.</span>` : ""}</p>
        ${tosTable()}
        <label class="tog col"><span><input type="checkbox" data-s="useFF" ${S.useFF ? "checked" : ""}> <b>Use FF Scouter for battle stats and win chance</b></span>
          <small class="muted">Sends your key and the player IDs you look at to ffscouter.com. Register your key there once. Their terms: <a href="https://ffscouter.com" target="_blank" rel="noopener">ffscouter.com</a></small></label>
        ${ffErr ? `<p class="small r">${esc(ffErr)}</p>` : ""}
        <button class="btn ghost" data-act="ffTest">Test FF Scouter</button>
        <div class="fftest small muted"></div>
        <label class="blk">Torn Stats key <small class="muted">(optional, for spy reports)</small>
          <input class="key" data-k="tsKey" type="password" autocomplete="off" placeholder="leave empty if you don't use Torn Stats" value="${esc(S.tsKey)}">
        </label>
        <label class="blk">Limited key for mug results <small class="muted">(optional)</small>
          <input class="key" data-k="eventsKey" type="password" autocomplete="off" placeholder="leave empty to use the key above" value="${esc(S.eventsKey || "")}">
        </label>
        <p class="muted small">Only used to read your own events ("...mugged them for $X") so the script can learn from your mugs. Only sent to api.torn.com.</p>
        <p class="muted small">Only sent to tornstats.com, to read spy reports on a player's page. Their terms: <a href="https://www.tornstats.com" target="_blank" rel="noopener">tornstats.com</a></p>

        <h3>API use</h3>
        ${numIn("apiPerMin", "Max Torn API calls per minute", 'min="5" max="100"')}
        <p class="muted small">Torn allows 100 a minute shared by all your tools. Keep room for Torn PDA and other scripts.</p>
        ${numIn("pollSec", "Check watched players every (seconds)", 'min="30"')}
        ${numIn("bazaarMin", "Check their bazaars every (minutes)", 'min="2"')}

        <h3>Alerts</h3>
        ${al("mug", "🔥 Mug chance (live sales over your alert amount)")}
        ${al("online", "Came online")}
        ${al("offline", "Went offline")}
        ${al("hosp", "Hospital in / out")}
        ${al("jail", "Jail in / out")}
        ${al("travel", "Took off")}
        ${al("land", "Landed")}
        ${al("bazaar", "Bazaar listed / sold")}
        ${al("market", "Item Market listed / sold")}
        <label class="tog"><input type="checkbox" data-s="alertPopup" ${S.alertPopup ? "checked" : ""}> Pop-up at the top of the screen</label>
        <label class="tog"><input type="checkbox" data-s="alertVibrate" ${S.alertVibrate ? "checked" : ""}> Vibrate</label>
        <button class="btn ghost" data-act="testAlert">Test alert</button>

        <h3>Win chance + mugging</h3>
        <label class="tog">My total battle stats<input class="num wide" data-n="myTotal" type="number" inputmode="numeric" value="${esc(S.myTotal || "")}" placeholder="optional"></label>
        <p class="muted small">Optional. Makes win chance more accurate. Find it on your Home page (Battle Stats → Total). Without it, the Fair Fight number from FF Scouter is used.</p>
        ${numIn("mugMerits", "Mugging merits (0–10)", 'min="0" max="10"')}
        ${numIn("plunder", "Plunder bonus on my weapon (%)", 'min="0" max="100"')}
        ${numIn("wageShare", "Guess: wages = % of company income per worker", 'min="1" max="100"')}

        <h3>🧠 Learning from your mugs</h3>
        ${learnBox()}

        <h3>TornW3B scanner (finds sellers for Live sales)</h3>
        <label class="tog"><input type="checkbox" data-s="salesScan" ${S.salesScan ? "checked" : ""}> Scan TornW3B bazaars for sales (no API key used)</label>
        ${numIn("salesItems", "Popular items to scan", 'min="5" max="60"')}
        ${numIn("salesScanMin", "Scan every (minutes)", 'min="5"')}

        <h3>Find more players</h3>
        ${["networth", "offences", "level", "factions"].map((k) => `<label class="tog"><input type="checkbox" data-gs="${k}" ${S.grow.sources[k] ? "checked" : ""}> ${{ networth: "Hall of Fame: Networth (rich players)", offences: "Hall of Fame: Offences", level: "Hall of Fame: Level", factions: "Faction member lists" }[k]}</label>`).join("")}
        <label class="tog">API calls per tap<input class="num" data-gc="1" type="number" inputmode="numeric" value="${esc(S.grow.calls)}"></label>
        <p class="muted small">${Object.keys(DB).length.toLocaleString()} players saved. <button class="link" data-act="clearDb">Clear list</button></p>

        <h3>Other</h3>
        <button class="btn ghost" data-act="resetFab">Reset 👁️ button position</button>
        <button class="btn ghost" data-act="clearMugged">Clear 'mugged' marks</button>

        <h3>About</h3>
        <div class="about">
          <div><b>Torn Watch Geek v${VERSION}</b></div>
          <div class="small muted">Reads data only. Buttons just open Torn pages; every attack is yours.</div>
          <button class="btn ghost" data-act="checkUpdate">Check for updates</button>
          <div class="upd small muted"></div>
        </div>
      </div>`;
    $$("[data-k]").forEach((el) =>
      el.addEventListener("change", () => {
        S[el.dataset.k] = el.value.trim();
        save();
        memo.clear();
        deadKey = "";
        for (const k of Object.keys(ffTried)) delete ffTried[k];
        ffErr = "";
        toast("Saved");
      })
    );
    $$("[data-al]").forEach((el) => el.addEventListener("change", () => ((S.alerts[el.dataset.al] = el.checked), save())));
    $$("[data-s]").forEach((el) => el.addEventListener("change", () => ((S[el.dataset.s] = el.checked), save())));
    $$("[data-gs]").forEach((el) => el.addEventListener("change", () => ((S.grow.sources[el.dataset.gs] = el.checked), save())));
    $$("[data-gc]").forEach((el) => el.addEventListener("change", () => ((S.grow.calls = Math.max(1, Math.min(50, +el.value || 10))), save())));
    $$("[data-n]").forEach((el) =>
      el.addEventListener("change", () => {
        S[el.dataset.n] = Math.max(0, parseFloat(el.value) || 0);
        save();
        toast("Saved");
      })
    );
  }

  // ---------------------------------------------------------------- actions
  function addWatch(id) {
    id = +id;
    if (!id) return toast("Enter a player ID", "bad");
    if (id === myId) return toast("That's you", "bad");
    if (W[id]) return toast("Already watching");
    W[id] = { name: (DB[id] && DB[id].n) || "#" + id, added: now(), log: [] };
    saveSoon("watch");
    toast("Watching " + W[id].name, "ok");
    getProfile(id, { hi: true, ttl: 0 })
      .then(() => isOpen() && render())
      .catch((e) => toast(e.message, "bad"));
    stats(id).then(() => isOpen() && renderSoon());
    W[id].bzNext = now() + Math.max(2, +S.bazaarMin || 5) * MIN;
    checkBazaar(id).catch(() => {});
  }

  root.addEventListener("click", async (e) => {
    const link = e.target.closest("a[href]");
    if (link && /sid=attack/.test(link.getAttribute("href"))) {
      rememberAttack(+((link.getAttribute("href").match(/user2ID=(\d+)/) || [])[1] || 0));
      try {
        sessionStorage.setItem("twg_reopen", JSON.stringify({ t: now(), tab: S.tab, hunt: S.hunt }));
      } catch {}
    }
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const id = +el.dataset.id || 0;
    switch (act) {
      case "toggle":
        if (fabDragged) return;
        isOpen() ? close() : open();
        break;
      case "close":
        close();
        break;
      case "back":
        back();
        break;
      case "settings":
        go("settings");
        break;
      case "tab":
        go(el.dataset.tab);
        break;
      case "player":
        go("player", id);
        break;
      case "watchAdd":
        addWatch(id);
        render();
        break;
      case "watchAddInput":
        addWatch(+($(".addid").value || "").replace(/\D/g, ""));
        render();
        break;
      case "watchDel":
        delete W[id];
        saveSoon("watch");
        toast("Stopped watching");
        render();
        break;
      case "bzToggle":
        if (W[id]) {
          W[id].bazaar = el.checked;
          saveSoon("watch");
        }
        break;
      case "mugged":
        MUGGED[id] = now();
        saveSoon("mugged");
        toast("Marked as mugged. Hidden from Hunt for a while.", "ok");
        if (view.name === "hunt") {
          const r = view.results && view.results.list.find((x) => x.id === id);
          if (r) r.hidden = true;
          drawResults();
        } else render();
        break;
      case "unmug":
        delete MUGGED[id];
        saveSoon("mugged");
        render();
        break;
      case "hunt":
        S.hunt = el.dataset.mode;
        save();
        view.msg = "";
        if (view.results && view.results.mode !== S.hunt) view.results = null;
        render();
        break;
      case "liveToggle":
        S.live.running = !S.live.running;
        save();
        if (S.live.running && !Object.keys(POOL).length) fillPool(true);
        liveForm();
        break;
      case "liveMin":
        S.live.min = +el.dataset.v;
        save();
        liveForm();
        break;
      case "poolAdd": {
        const pid = +($(".poolid").value || "").replace(/\D/g, "");
        if (!pid) return toast("Enter a player ID", "bad");
        addToPool(pid, (DB[pid] && DB[pid].n) || "", "you", true);
        toast("Added to pool", "ok");
        liveForm();
        break;
      }
      case "poolDel":
        delete POOL[id];
        saveSoon("pool");
        liveForm();
        break;
      case "poolFill":
        toast("Filling pool…", "busy", 0);
        await fillPool(true);
        toast(`Pool has ${Object.keys(POOL).length} sellers`, "ok");
        liveForm();
        break;
      case "liveClear":
        LIVE = [];
        saveSoon("live");
        drawLive();
        break;
      case "scanNow":
        toast("Scanning bazaars…", "busy", 0);
        await scanSales(true);
        toast(w3bStatus, "ok");
        break;
      case "sctype": {
        const t = +el.dataset.id;
        const L = S.search.ctypes;
        S.search.ctypes = L.includes(t) ? L.filter((x) => x !== t) : [...L, t];
        save();
        $$(`.chip[data-act=sctype][data-id="${t}"]`).forEach((c) => c.classList.toggle("on", S.search.ctypes.includes(t)));
        const pk = $(".cpicked");
        if (pk) pk.innerHTML = S.search.ctypes.length ? "Picked: <b>" + S.search.ctypes.map((x) => esc(typeName(x))).join(", ") + "</b>" : "None picked: searching your saved players only.";
        break;
      }
      case "searchGo":
        searchGo();
        break;
      case "searchReset":
        S.search = Object.assign({}, DEFAULTS.search);
        save();
        view.results = null;
        view.msg = "Filters cleared. Tap Search to list your saved players.";
        render();
        break;
      case "grow":
        if (!apiKey()) return toast("Add an API key first", "bad");
        el.disabled = true;
        await growDb(Math.max(1, +S.grow.calls || 10));
        break;
      case "feedClear":
        EVENTS = [];
        saveSoon("events");
        render();
        break;
      case "alertNext":
        alertQueue.shift();
        drawAlert();
        break;
      case "alertOpen":
        alertQueue = [];
        drawAlert();
        open();
        go("player", id);
        break;
      case "ffTest": {
        const out = $(".fftest");
        const key = apiKey();
        if (!key) {
          out.textContent = "No API key yet.";
          break;
        }
        out.className = "fftest small muted";
        out.textContent = "Asking FF Scouter…";
        // Raw request, so we can show exactly what FF Scouter answers.
        const target = myId || 1;
        const url = `${FFS}?key=${encodeURIComponent(key)}&targets=${target}&t=${Date.now()}`;
        let status = "?",
          text = "";
        try {
          if (typeof window.PDA_httpGet === "function") {
            const r = await window.PDA_httpGet(url, {});
            status = r ? r.status : "no answer";
            text = r ? r.responseText : "";
          } else if (typeof GM_xmlhttpRequest === "function") {
            const r = await new Promise((res, rej) => GM_xmlhttpRequest({ method: "GET", url, onload: res, onerror: () => rej(new Error("network error")) }));
            status = r.status;
            text = r.responseText;
          } else {
            const r = await fetch(url);
            status = r.status;
            text = await r.text();
          }
        } catch (er) {
          text = er.message;
        }
        let ok = false;
        try {
          const d = JSON.parse(text);
          const arr = Array.isArray(d) ? d : d.data || d.results || [];
          ok = Array.isArray(arr) && !d.error;
          if (ok) {
            ffErr = "";
            for (const k of Object.keys(ffTried)) delete ffTried[k];
          }
        } catch {}
        out.className = "fftest small " + (ok ? "g" : "r");
        out.innerHTML = `${ok ? "✅ FF Scouter works with this key." : "❌ FF Scouter said no."} <br><span class="muted">Key used: ${esc(key.slice(0, 4))}…${esc(key.slice(-2))} · status ${esc(status)} · reply: ${esc(String(text).slice(0, 220))}</span>`;
        break;
      }
      case "evCheck":
        toast("Reading your events…", "busy", 0);
        await checkMugEvents(true);
        toast(LEARN.evErr || "Events checked", LEARN.evErr ? "bad" : "ok");
        render();
        break;
      case "learnReset":
        Object.assign(LEARN, { worker: [], live: [], log: [], pending: {} });
        saveLearn();
        render();
        break;
      case "tofSet": {
        const w = W[id];
        if (!w || !w.trip) break;
        const ago = $(".tof-ago").value.trim();
        const tm = $(".tof-time").value;
        const tz = $(".tof-tz").value;
        let dep = 0;
        if (ago !== "") dep = now() - Math.max(0, +ago) * MIN;
        else if (tm) {
          const [hh, mm] = tm.split(":").map(Number);
          const d = new Date();
          if (tz === "tct") d.setUTCHours(hh, mm, 0, 0);
          else d.setHours(hh, mm, 0, 0);
          dep = d.getTime();
          if (dep > now() + MIN) dep -= DAY; // a time later than now means yesterday
        }
        if (!dep) return toast("Enter a time or minutes ago", "bad");
        if (dep > now()) dep = now();
        Object.assign(w.trip, { depLo: dep - MIN, depHi: dep + MIN, manual: true, manualClock: tm || "", manualTz: tz });
        saveSoon("watch");
        toast("Take-off time set", "ok");
        render();
        break;
      }
      case "tofClear": {
        const w = W[id];
        if (w && w.trip) {
          Object.assign(w.trip, { depLo: 0, manual: false, manualClock: "" });
          saveSoon("watch");
        }
        render();
        break;
      }
      case "testAlert":
        showAlert({ t: now(), pid: myId || 1, name: "Test", kind: "land", text: "landed in Japan · flies Airstrip" });
        break;
      case "resetFab":
        S.fab = null;
        save();
        placeFab();
        break;
      case "clearMugged":
        for (const k of Object.keys(MUGGED)) delete MUGGED[k];
        saveSoon("mugged");
        toast("Cleared");
        break;
      case "clearDb":
        for (const k of Object.keys(DB)) if (!W[k]) delete DB[k];
        Object.assign(GROW, { networth: 0, offences: 0, level: 0, facs: {}, facQueue: [] });
        saveSoon("db");
        saveSoon("grow");
        render();
        break;
      case "checkUpdate": {
        const out = $(".upd");
        out.className = "upd small muted";
        out.textContent = "Checking…";
        try {
          // Ask for the file itself (not JSON), bypassing caches, and read its @version line.
          const url = UPDATE_URL + "?t=" + Date.now();
          let text;
          if (typeof window.PDA_httpGet === "function") text = (await window.PDA_httpGet(url, {}))?.responseText;
          else if (typeof GM_xmlhttpRequest === "function")
            text = await new Promise((res, rej) => GM_xmlhttpRequest({ method: "GET", url, onload: (r) => res(r.responseText), onerror: rej }));
          else text = await (await fetch(url)).text();
          const latest = ((text || "").match(/@version\s+(\S+)/) || [])[1];
          if (!latest) throw new Error("couldn't read the latest version");
          const newer = latest.split(".").map(Number).reduce((r, n, i) => r || (n > (+VERSION.split(".")[i] || 0) ? 1 : n < (+VERSION.split(".")[i] || 0) ? -1 : 0), 0) > 0;
          out.className = "upd small " + (newer ? "a" : "g");
          out.textContent = newer
            ? `Version ${latest} is available. Close and reopen Torn PDA, or go to Settings → Userscripts and check for updates.`
            : `You're up to date (latest is ${latest}).`;
        } catch (er) {
          out.className = "upd small r";
          out.textContent = "Couldn't check: " + er.message;
        }
        break;
      }
    }
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("addid")) {
      addWatch(+(e.target.value || "").replace(/\D/g, ""));
      render();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  // ---------------------------------------------------------------- draggable button
  let fabDragged = false;
  function placeFab() {
    const fab = $(".fab");
    const p = S.fab;
    if (!p) {
      fab.style.right = "14px";
      fab.style.bottom = "146px";
      return;
    }
    fab.style.right = Math.min(Math.max(4, p.right), innerWidth - 56) + "px";
    fab.style.bottom = Math.min(Math.max(4, p.bottom), innerHeight - 56) + "px";
  }
  function setupDrag() {
    const fab = $(".fab");
    let start = null;
    fab.addEventListener("pointerdown", (e) => {
      const r = fab.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, right: innerWidth - r.right, bottom: innerHeight - r.bottom, moved: false };
      fabDragged = false;
      fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x,
        dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 8) return;
      start.moved = true;
      S.fab = { right: start.right - dx, bottom: start.bottom - dy };
      placeFab();
    });
    const end = () => {
      if (start && start.moved) {
        fabDragged = true; // swallow the click that follows a drag
        setTimeout(() => (fabDragged = false), 50);
        save();
      }
      start = null;
    };
    fab.addEventListener("pointerup", end);
    fab.addEventListener("pointercancel", end);
    addEventListener("resize", placeFab);
    placeFab();
  }

  function updateBadge() {
    const b = $(".fab-badge");
    const unseen = EVENTS.filter((e) => !e.seen).length;
    const ctx = profileContext();
    if (unseen) {
      b.hidden = false;
      b.textContent = unseen > 99 ? "99+" : unseen;
      b.className = "fab-badge warn";
    } else if (ctx && ctx !== myId && !W[ctx]) {
      b.hidden = false;
      b.textContent = "☆";
      b.className = "fab-badge";
    } else b.hidden = true;
  }

  // ---------------------------------------------------------------- boot
  function onRoute() {
    updateBadge();
    imLastSig = "";
    if (marketItemId()) setTimeout(scanMarketPage, 800);
    if (isOpen() && view.name === "watch") render();
  }
  function boot() {
    document.body.appendChild(host);
    setupDrag();
    updateBadge();
    loadMyStats();
    if (apiKey()) setTimeout(() => companyTypes().catch(() => {}), 5 * SEC);
    setInterval(pollWatch, 5 * SEC);
    setTimeout(pollWatch, 1500);
    setInterval(() => scanSales(false), MIN);
    setInterval(liveTick, 500);
    setInterval(() => checkMugEvents(false), 30 * SEC);
    setTimeout(() => scanSales(false), 20 * SEC);
    // Live countdowns on the Watch tab
    setInterval(() => isOpen() && (view.name === "watch" || view.name === "player") && renderSoon(), 30 * SEC);
    window.addEventListener("hashchange", onRoute);
    addEventListener("pagehide", () => store.set("db", DB));
    document.addEventListener("visibilitychange", () => !document.hidden && pollWatch());
    // Torn's pages change the URL with pushState too.
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onRoute();
      }
    }, 1000);
    // Item Market: read listings as Torn draws them.
    new MutationObserver(() => {
      if (/sid=attack/i.test(location.href)) {
        clearTimeout(atkTimer);
        atkTimer = setTimeout(scanAttackPage, 600);
      }
      if (!marketItemId()) return;
      clearTimeout(imTimer);
      imTimer = setTimeout(scanMarketPage, 700);
    }).observe(document.body, { childList: true, subtree: true });
    onRoute();
    // Back from an attack started in the script: open it again where you left off.
    try {
      const r = JSON.parse(sessionStorage.getItem("twg_reopen") || "null");
      if (r && !/sid=attack/.test(location.href)) {
        sessionStorage.removeItem("twg_reopen");
        if (now() - r.t < 15 * MIN) {
          view.name = r.tab || "hunt";
          open();
        }
      }
    } catch {}
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);

  // ---------------------------------------------------------------- styles
  function CSS() {
    return `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
button { font: inherit; cursor: pointer; }
[hidden] { display: none !important; }
:host {
  --bg: #1d1f22; --bg2: #26292d; --bg3: #30343a; --line: #3a3f46; --text: #e9ecef; --muted: #9aa3ad;
  --acc: #74c0fc; --g: #7fdc6f; --r: #ff8787; --amber: #ffd43b; --orange: #ffa94d;
}
.fab { position: fixed; right: 14px; bottom: 146px; z-index: 2147483000; width: 52px; height: 52px; border-radius: 50%;
  border: 1px solid var(--line); background: var(--bg2); color: var(--text); box-shadow: 0 4px 14px rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center; font-size: 24px; -webkit-tap-highlight-color: transparent;
  touch-action: none; user-select: none; -webkit-user-select: none; }
.fab:active { transform: scale(.95); }
.fab-ico { display: flex; color: var(--acc); }
.fab-badge { position: absolute; top: -6px; right: -6px; min-width: 22px; padding: 2px 6px; border-radius: 11px;
  font-size: 11px; font-weight: 700; background: var(--acc); color: #0b1a26; white-space: nowrap; text-align: center; }
.fab-badge.warn { background: var(--amber); color: #2b2200; }
.scrim { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.45); }
.panel { position: fixed; z-index: 2147483002; left: 0; right: 0; bottom: 0; height: 88vh; height: 88dvh;
  background: var(--bg); color: var(--text); border-radius: 16px 16px 0 0; border: 1px solid var(--line);
  display: flex; flex-direction: column; box-shadow: 0 -8px 30px rgba(0,0,0,.5); font-size: 14px; line-height: 1.35; }
@media (min-width: 760px) { .panel { left: auto; top: 0; height: 100vh; width: 460px; border-radius: 0; } }
.top { display: flex; align-items: center; gap: 6px; padding: 10px 10px 8px; }
.title { flex: 1; font-weight: 700; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tabs { display: flex; gap: 4px; padding: 0 10px 8px; border-bottom: 1px solid var(--line); }
.tab { flex: 1; background: var(--bg2); border: 1px solid var(--line); color: var(--muted); border-radius: 10px; padding: 7px 4px; font-size: 13px; }
.tab.on { color: var(--text); border-color: var(--acc); font-weight: 700; }
.ib { background: var(--bg2); border: 1px solid var(--line); color: var(--text); border-radius: 10px; min-width: 36px; height: 36px; font-size: 17px; padding: 0 8px;
  display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }
.ib.sm { min-width: 30px; height: 30px; font-size: 14px; padding: 0 6px; }
.ib.star.on { color: var(--amber); }
.body { flex: 1; overflow-y: auto; padding: 12px; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 16px 2px 8px; }
h3 small { text-transform: none; letter-spacing: 0; }
.muted { color: var(--muted); } .small { font-size: 12px; } .g { color: var(--g); } .r { color: var(--r); } .a { color: var(--amber); } .err { color: var(--r); }
.hint { padding: 8px 4px; } .foot { margin-top: 14px; text-align: center; }
input, select { font: inherit; font-size: 16px; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; width: 100%; outline: none; min-width: 0; }
input:focus, select:focus { border-color: var(--acc); }
.warnbox { border: 1px solid var(--amber); border-radius: 12px; padding: 8px 10px; margin-bottom: 10px; font-size: 13px; }
.addrow { display: flex; gap: 8px; margin-bottom: 10px; }
.addrow .btn { flex: none; height: auto; }
.list { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: var(--bg2); border: 1px solid var(--line);
  color: var(--text); border-radius: 12px; padding: 8px 10px; }
.row .nm { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; }
.row small { display: block; font-weight: 400; font-size: 11px; color: var(--muted); }
.row small.trav { color: var(--acc); font-size: 12px; }
.row small.trav small { display: inline; }
.row small.trav .tl2, .box .tl2 { display: block; font-weight: 400; font-size: 12px; margin-top: 2px; }
.row .rt { text-align: right; flex: none; max-width: 48%; }
.row .rt small { margin-top: 3px; }
.row.ev { align-items: flex-start; }
.evi { font-size: 18px; flex: none; }
.evt { font-weight: 400; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #5c636b; flex: none; }
.dot.on { background: var(--g); box-shadow: 0 0 0 3px rgba(127,220,111,.18); }
.dot.idle { background: var(--amber); }
.ctx { display: block; width: 100%; margin: 0 0 10px; padding: 10px; border-radius: 12px; border: 1px dashed var(--amber); background: transparent; color: var(--amber); text-align: left; font-weight: 700; }
.ctx small { font-weight: 400; color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 4px; max-height: 150px; overflow-y: auto; }
.chip { background: var(--bg2); border: 1px solid var(--line); color: var(--text); border-radius: 999px; padding: 6px 12px; font-size: 13px; }
.chip.on { border-color: var(--acc); background: rgba(116,192,252,.15); color: var(--acc); font-weight: 700; }
.phead { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.grow { flex: 1; min-width: 0; }
.iname { font-weight: 700; font-size: 17px; }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.stat { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; min-width: 0; }
.stat > span { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.stat b { font-size: 16px; display: block; overflow: hidden; text-overflow: ellipsis; }
.stat small { display: block; font-size: 11px; color: var(--muted); }
.box { margin-top: 10px; padding: 8px 10px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg2); font-size: 13px; }
.box > div { margin-top: 3px; }
.pill { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 999px; vertical-align: middle; white-space: nowrap; }
.pill.easy { background: rgba(127,220,111,.15); color: var(--g); } .pill.likely { background: rgba(255,212,59,.15); color: var(--amber); }
.pill.risky { background: rgba(255,169,77,.15); color: var(--orange); } .pill.avoid { background: rgba(255,135,135,.15); color: var(--r); }
.pill.unk, .pill.even { background: var(--bg3); color: var(--muted); }
.row-btn { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0 6px; }
.row-btn .btn.ghost { margin: 0; }
.log { display: grid; gap: 4px; font-size: 13px; }
.tof { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line); display: grid; gap: 6px; }
.tof-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tof-row input, .tof-row select { width: auto; flex: 1; min-width: 90px; padding: 6px 8px; font-size: 15px; }
.tof-row .tof-ago { flex: 0 0 80px; min-width: 70px; }
.mini-list { display: grid; gap: 3px; font-size: 13px; }
.mini-list div { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--line); padding: 3px 0; }
.feedtop { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.feedtop .btn.ghost { margin: 0; }
.filters { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 10px; }
.filters.two { grid-template-columns: 1fr 1fr; }
.filters.four { grid-template-columns: 1fr 1fr 1fr 1fr; }
.filters label { font-size: 11px; color: var(--muted); display: flex; flex-direction: column; gap: 3px; justify-content: flex-end; }
.filters input, .filters select { padding: 7px 8px; }
.sorts { display: flex; gap: 4px; background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 3px; }
.seg { flex: 1; background: transparent; border: 0; color: var(--muted); border-radius: 9px; padding: 7px 2px; font-size: 12px; }
.seg.on { background: var(--bg3); color: var(--text); font-weight: 700; }
.hunt-msg { margin: 10px 2px 6px; min-height: 1em; }
.livebar { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.livebar .btn.ghost { margin: 0; }
.chip-in { width: 110px; padding: 5px 10px; border-radius: 999px; font-size: 13px; }
.live-list { margin-top: 10px; }
.livesum { margin: 0 2px 8px; color: var(--muted); }
.cbox { margin-top: 10px; padding: 10px; border: 1px solid var(--acc); border-radius: 12px; background: rgba(116,192,252,.06); }
.cbox-h { font-size: 14px; }
.cbox .chips { margin: 8px 0 4px; }
.cpicked { margin-top: 2px; }
.cbox details.more { margin-top: 6px; }
.fftest { margin: 4px 0 10px; word-break: break-word; }
.lrow.hotrow { border-color: rgba(255,169,77,.6); }
.hot { color: var(--orange); font-weight: 700; }
details.pool .mini-list { margin-top: 8px; }
.cards { display: flex; flex-direction: column; gap: 6px; }
.card { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 9px 10px; }
.card.dim { opacity: .55; }
.card .small { margin-top: 2px; }
.crow { display: flex; align-items: flex-start; gap: 8px; }
.c1 { flex: 1; min-width: 0; }
.nmlink { font-weight: 700; font-size: 15px; text-decoration: none; }
.c2 { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex: none; }
.c2b { display: flex; gap: 4px; }
.btn { display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px; border-radius: 10px; border: 0;
  background: var(--acc); color: #0b1a26; font-weight: 700; text-decoration: none; font-size: 14px; }
.btn.sm { height: 30px; padding: 0 10px; font-size: 13px; }
.btn.ghost { background: var(--bg2); color: var(--text); border: 1px solid var(--line); margin: 0 6px 6px 0; }
.btn:disabled { opacity: .6; }
.link { background: none; border: 0; color: var(--acc); padding: 0; text-decoration: underline; font-size: inherit; text-align: left; }
details.more { margin-top: 10px; } details.more summary { cursor: pointer; color: var(--muted); font-size: 13px; padding: 4px 2px; }
details.more .weekly { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.form .blk { display: flex; flex-direction: column; gap: 6px; font-weight: 600; margin-top: 8px; }
.tog { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
.tog input[type=checkbox] { width: 20px; height: 20px; flex: none; }
.tog input.num { width: 80px; margin-left: auto; flex: none; }
.tog input.num.wide { width: 150px; }
.about { display: grid; gap: 6px; justify-items: start; }
.tos-t { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; }
.tos-t th, .tos-t td { text-align: left; vertical-align: top; padding: 5px 4px; border-bottom: 1px solid var(--line); }
.tos-t th { color: var(--muted); font-weight: 600; width: 34%; }
.tog.col { flex-direction: column; align-items: stretch; gap: 3px; }
.tog.col > span { display: flex; align-items: center; gap: 10px; }
.tog a, .form a { color: var(--acc); }
.about .btn.ghost { margin: 0; }
.spin { width: 28px; height: 28px; margin: 30px auto; border-radius: 50%; border: 3px solid var(--line); border-top-color: var(--acc); animation: sp .8s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 3s; } }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483005; background: var(--bg3); color: var(--text);
  padding: 8px 14px; border-radius: 10px; border: 1px solid var(--line); font-size: 13px; max-width: calc(100vw - 32px); }
.toast.busy { color: var(--acc); border-color: var(--acc); }
.toast.ok { color: var(--g); border-color: var(--g); }
.toast.bad { color: var(--r); border-color: var(--r); }
.alert { position: fixed; left: 8px; right: 8px; top: 8px; z-index: 2147483004; background: var(--bg); color: var(--text);
  border: 1px solid var(--amber); border-radius: 14px; padding: 10px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.5); font-size: 14px;
  display: flex; align-items: center; gap: 10px; }
@media (min-width: 760px) { .alert { left: auto; width: 420px; } }
.al-txt { flex: 1; min-width: 0; } .al-txt small { display: block; color: var(--muted); font-size: 11px; }
.al-btns { display: flex; gap: 6px; flex: none; }
`;
  }
})();
