/**
 * Torn Watch Geek - Background Tracker (Google Apps Script)
 *
 * Runs in YOUR Google account, every minute, even when your phone is off.
 * It checks the players you watch in Torn Watch Geek through the official Torn API,
 * writes every change to the "Log" sheet with the exact time, can send phone alerts
 * through the free ntfy app, and lets Torn Watch Geek read the log through a private link.
 *
 * Setup: Extensions > Apps Script in a Google Sheet, paste this file, Save,
 * reload the sheet, then use the "Torn Tracker" menu > Setup.
 * Full steps: https://github.com/SarcasticGeekJr/torn-watch-geek#background-tracker
 *
 * Your API key is stored only in this script's properties, in your own Google account.
 * It is only sent to api.torn.com. Nothing is shared with anyone else.
 */

const TRACKER_VERSION = "1.0.1";
const MAX_PLAYERS = 12; // Google's free daily limits allow about this many at one check per minute
const KEEP_ROWS = 5000;
const DEAD_KEY = [1, 2, 10, 13, 18]; // Torn: wrong, paused or disabled key - stop using it

// Flight minutes, one way: [Standard, Airstrip, WLT/Private, Business] (same table as Torn Watch Geek)
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
const ALERT_KINDS = {
  travel: "Took off",
  land: "Landed",
  hosp: "Hospital in / out",
  jail: "Jail in / out",
  online: "Came online",
  offline: "Went offline",
  bazaar: "Bazaar sold / listed",
};
const DEFAULT_ALERTS = { travel: true, land: true, hosp: true, jail: true, online: true, offline: false, bazaar: true };

// ------------------------------------------------------------------ menu + setup
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🛰 Torn Tracker")
    .addItem("Setup", "showSetup")
    .addItem("Show my link", "showLink")
    .addItem("Check now", "tick")
    .addItem("Stop tracking", "stopTracking")
    .addToUi();
}

function props() {
  return PropertiesService.getScriptProperties();
}

function getCfg() {
  const p = props().getProperties();
  return {
    key: p.KEY || "",
    topic: p.TOPIC || "",
    alerts: p.ALERTS ? JSON.parse(p.ALERTS) : DEFAULT_ALERTS,
    secret: p.SECRET || "",
    watch: p.WATCH ? JSON.parse(p.WATCH) : [],
    dead: p.DEAD || "",
    lastTick: +p.LAST_TICK || 0,
  };
}

function randomWord(n) {
  return Utilities.getUuid().replace(/-/g, "").slice(0, n);
}

function showSetup() {
  const c = getCfg();
  const topic = c.topic || "twg-" + randomWord(12);
  const html = HtmlService.createHtmlOutput(setupHtml(c, topic)).setTitle("Torn Tracker setup");
  SpreadsheetApp.getUi().showSidebar(html);
}

function setupHtml(c, topic) {
  const checks = Object.keys(ALERT_KINDS)
    .map((k) => '<label><input type="checkbox" name="al" value="' + k + '"' + (c.alerts[k] ? " checked" : "") + "> " + ALERT_KINDS[k] + "</label>")
    .join("<br>");
  return (
    "<style>body{font-family:Arial,sans-serif;font-size:14px;padding:6px}input[type=text],input[type=password]{width:100%;padding:6px;margin:4px 0 10px}" +
    "button{padding:8px 14px;font-size:14px}.ok{color:#2b8a3e}.bad{color:#c92a2a}small{color:#666}</style>" +
    "<b>1. Your Torn API key</b><br><small>A Public key is enough. It is stored only in this script, in your Google account, and only sent to api.torn.com.</small>" +
    '<input id="key" type="password" placeholder="' + (c.key ? "saved (leave empty to keep)" : "16 characters") + '">' +
    "<b>2. Phone alerts (optional)</b><br><small>Install the free <b>ntfy</b> app and subscribe to this topic name. Anyone who knows the name can see the alerts, so keep it random.</small>" +
    '<input id="topic" type="text" value="' + topic + '">' +
    checks +
    '<br><br><button onclick="save()">Save and start tracking</button><p id="out"></p>' +
    "<script>function save(){var al={};document.querySelectorAll('input[name=al]').forEach(function(x){al[x.value]=x.checked});" +
    "document.getElementById('out').textContent='Saving...';" +
    "google.script.run.withSuccessHandler(function(r){var o=document.getElementById('out');if(r.error){o.className='bad';o.textContent=r.error;return}" +
    "o.className='ok';o.innerHTML='Saved. Tracking every minute as '+r.name+'.<br><br><b>Next:</b> Deploy &gt; New deployment &gt; type: Web app, Execute as: Me, Who has access: Anyone &gt; Deploy. Then menu Torn Tracker &gt; Show my link.'})" +
    ".withFailureHandler(function(e){var o=document.getElementById('out');o.className='bad';o.textContent=e.message})" +
    ".saveSettings({key:document.getElementById('key').value.trim(),topic:document.getElementById('topic').value.trim(),alerts:al})}</script>"
  );
}

function saveSettings(o) {
  const c = getCfg();
  const key = (o.key || c.key || "").trim();
  if (!key) return { error: "Enter your API key." };
  const r = UrlFetchApp.fetch("https://api.torn.com/user/?selections=basic&key=" + encodeURIComponent(key) + "&comment=TWGTracker", { muteHttpExceptions: true });
  let d = {};
  try {
    d = JSON.parse(r.getContentText());
  } catch (e) {
    return { error: "Couldn't reach the Torn API. Try again." };
  }
  if (d.error) return { error: "Torn says: " + d.error.error };
  const p = props();
  p.setProperty("KEY", key);
  p.setProperty("TOPIC", (o.topic || "").trim());
  p.setProperty("ALERTS", JSON.stringify(o.alerts || DEFAULT_ALERTS));
  if (!c.secret) p.setProperty("SECRET", randomWord(24));
  p.deleteProperty("DEAD");
  logSheet();
  startTrigger();
  return { ok: true, name: d.name || "you" };
}

function startTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "tick")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("tick").timeBased().everyMinutes(1).create();
}

function stopTracking() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "tick")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  SpreadsheetApp.getUi().alert("Tracking stopped. Use Torn Tracker > Setup to start again.");
}

function showLink() {
  const c = getCfg();
  const url = ScriptApp.getService().getUrl();
  const ui = SpreadsheetApp.getUi();
  if (!c.secret) return ui.alert("Run Torn Tracker > Setup first.");
  if (!url) return ui.alert("Deploy first: Deploy > New deployment > type: Web app, Execute as: Me, Who has access: Anyone > Deploy. Then come back here.");
  // Google sometimes hands back the test link (ending in /dev), which only works when signed in.
  const isExec = /\/exec$/.test(url);
  const link = isExec ? url + "?s=" + c.secret : "";
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;font-size:14px">' +
      (isExec
        ? 'Copy this link into Torn Watch Geek: Settings &gt; Background tracker link.<br><small>Keep it private: it can read your tracker log.</small><textarea style="width:100%;height:90px;margin-top:8px" onclick="this.select()">' + link + "</textarea>"
        : "Google gave the test link, which won't work from Torn PDA. Do this instead:<br>1. Deploy &gt; Manage deployments &gt; copy the Web app URL (it ends in <b>/exec</b>).<br>2. Add this to the end of it:" +
          '<textarea style="width:100%;height:40px;margin-top:8px" onclick="this.select()">?s=' + c.secret + "</textarea>3. Paste the whole thing into Torn Watch Geek: Settings &gt; Background tracker link.") +
      "<p><small>Test: open the link in a browser. It should show {\"ok\":true,...}. A Google sign-in page means the deployment isn't set to Who has access: Anyone.</small></p>" +
      (c.topic ? "<p>ntfy topic for phone alerts: <b>" + c.topic + "</b></p>" : "") +
      "</div>"
  ).setWidth(440).setHeight(320);
  ui.showModalDialog(html, "Your tracker link");
}

// ------------------------------------------------------------------ the check (every minute)
function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const c = getCfg();
    if (!c.key || c.dead) return;
    const ids = c.watch.slice(0, MAX_PLAYERS);
    const t = Date.now();
    if (ids.length) {
      const reqs = ids.map((id) => ({ url: "https://api.torn.com/user/" + id + "?selections=profile,bazaar&key=" + encodeURIComponent(c.key) + "&comment=TWGTracker", muteHttpExceptions: true }));
      const res = UrlFetchApp.fetchAll(reqs);
      const events = [];
      res.forEach((r, i) => {
        let d;
        try {
          d = JSON.parse(r.getContentText());
        } catch (e) {
          return;
        }
        if (d.error) {
          if (DEAD_KEY.indexOf(+d.error.code) >= 0) {
            props().setProperty("DEAD", d.error.error || "key error");
            notify(c, "Torn Tracker stopped", "Torn says your API key stopped working (" + d.error.error + "). Run Setup again with a working key.");
          }
          return;
        }
        diffPlayer(+ids[i], d, t).forEach((e) => events.push(e));
      });
      if (events.length) {
        writeLog(events);
        events.forEach((e) => {
          if (c.alerts[e.kind]) notify(c, e.name, e.text);
        });
      }
    }
    props().setProperty("LAST_TICK", String(t));
  } finally {
    lock.releaseLock();
  }
}

function placeName(x) {
  const v = String(x || "").trim().replace(/[.!]$/, "");
  const alias = { "united arab emirates": "UAE", uae: "UAE", uk: "United Kingdom", cayman: "Cayman Islands", "torn city": "Torn", torn: "Torn" };
  if (alias[v.toLowerCase()]) return alias[v.toLowerCase()];
  return Object.keys(FLIGHT).filter((k) => k.toLowerCase() === v.toLowerCase())[0] || v;
}

// "Traveling to Japan", "Returning to Torn from Japan", "Traveling from Japan to Torn"
function parseTrip(st) {
  const desc = (st && st.description) || "";
  if (!st || st.state !== "Traveling") return null;
  const fromTo = desc.match(/from (.+?) to (.+)$/i);
  if (/Returning/i.test(desc)) {
    const m = desc.match(/from (.+)$/i);
    return { dir: "back", country: placeName(m ? m[1] : "") };
  }
  if (fromTo) {
    const a = placeName(fromTo[1]),
      b = placeName(fromTo[2]);
    return b === "Torn" ? { dir: "back", country: a } : { dir: "out", country: b };
  }
  const i = desc.lastIndexOf(" to ");
  const c = placeName(i >= 0 ? desc.slice(i + 4) : "");
  return c === "Torn" ? { dir: "back", country: "" } : { dir: "out", country: c };
}

function compactBazaar(raw) {
  let list = raw || [];
  if (!Array.isArray(list)) list = Object.keys(list).map((k) => list[k]);
  const out = {};
  list.forEach((it) => {
    const id = +(it.ID || it.id || it.item_id || 0);
    if (!id) return;
    const q = +(it.quantity != null ? it.quantity : it.amount) || 0;
    const p = +(it.price != null ? it.price : it.cost) || 0;
    const k = id + ":" + p;
    out[k] = [(out[k] ? out[k][0] : 0) + q, p, String(it.name || "Item " + id).slice(0, 30)];
  });
  // Keep the 50 biggest listings so the saved state stays small.
  const keys = Object.keys(out).sort((a, b) => out[b][0] * out[b][1] - out[a][0] * out[a][1]).slice(0, 50);
  const small = {};
  keys.forEach((k) => (small[k] = out[k]));
  return small;
}

function money(n) {
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + Math.round(n / 1e3) + "k";
  return "$" + n;
}

// Compare with the last check and return the events that happened.
function diffPlayer(id, d, t) {
  const st = d.status || {};
  const la = d.last_action || {};
  const prev = JSON.parse(props().getProperty("P_" + id) || "null");
  const cur = {
    n: d.name || (prev && prev.n) || "#" + id,
    st: st.state || "",
    until: +st.until || 0,
    on: la.status || "",
    la: +la.timestamp || 0,
    trip: parseTrip(st),
    abroad: st.state === "Abroad" ? placeName(String(st.description || "").replace(/^In /, "")) : "",
    plane: st.plane_image_type || st.travel_type || "",
    bz: compactBazaar(d.bazaar),
    t: t,
  };
  const ev = [];
  const add = (kind, text, x) => ev.push({ t: t, id: id, name: cur.n, kind: kind, text: text, x: x || {} });
  if (prev) {
    const fresh = prev.t && t - prev.t < 5 * 60 * 1000; // previous check close enough to time things
    if (fresh && prev.on && cur.on && prev.on !== cur.on) {
      if (cur.on === "Online") add("online", "came online");
      else if (cur.on === "Offline") add("offline", "went offline");
    }
    const key = (tr) => (tr ? tr.dir + ":" + tr.country : "");
    if (cur.trip && key(prev.trip) !== key(cur.trip)) {
      const depLo = fresh && !prev.trip ? prev.t : 0;
      cur.dep = [depLo, t];
      const route = cur.trip.dir === "back" ? (cur.trip.country || "abroad") + " -> Torn" : "Torn -> " + cur.trip.country;
      add("travel", "took off: " + route.replace("->", "→") + (depLo ? "" : " (time not exact)"), { dir: cur.trip.dir, country: cur.trip.country, depLo: depLo, depHi: t, plane: cur.plane });
    } else if (cur.trip && prev.trip) {
      cur.dep = prev.dep;
    }
    if (prev.trip && !cur.trip) {
      const where = prev.trip.dir === "back" ? "Torn" : prev.trip.country;
      add("land", "landed in " + where + (fresh ? "" : " (time not exact)"), {
        dir: prev.trip.dir,
        country: prev.trip.country,
        depLo: prev.dep ? prev.dep[0] : 0,
        depHi: prev.dep ? prev.dep[1] : 0,
        arrLo: fresh ? prev.t : 0,
        arrHi: t,
        plane: prev.plane || "",
      });
    }
    if (prev.st !== cur.st) {
      const left = cur.until ? " (" + Math.round((cur.until * 1000 - t) / 60000) + " min)" : "";
      if (cur.st === "Hospital") add("hosp", "went to hospital" + left);
      else if (prev.st === "Hospital") add("hosp", "left hospital");
      if (cur.st === "Jail" || cur.st === "Federal") add("jail", (cur.st === "Federal" ? "went to federal jail" : "went to jail") + left);
      else if (prev.st === "Jail") add("jail", "left jail");
    }
    // Bazaar: stock that went down is a sale (or removed), new stock is a listing.
    let sold = 0;
    const soldTxt = [],
      listTxt = [];
    Object.keys(prev.bz || {}).forEach((k) => {
      const o = prev.bz[k],
        n = cur.bz[k];
      const gone = o[0] - (n ? n[0] : 0);
      if (gone > 0) {
        sold += gone * o[1];
        soldTxt.push(gone + "x " + o[2]);
      }
    });
    Object.keys(cur.bz).forEach((k) => {
      const n = cur.bz[k],
        o = (prev.bz || {})[k];
      if (!o) listTxt.push(n[0] + "x " + n[2] + " @ " + money(n[1]));
      else if (n[0] > o[0]) listTxt.push("+" + (n[0] - o[0]) + "x " + n[2] + " @ " + money(n[1]));
    });
    if (sold > 0) add("bazaar", "sold or removed " + soldTxt.slice(0, 3).join(", ") + " (~" + money(sold) + ")", { sold: sold, away: cur.on !== "Online" || !!cur.trip });
    if (listTxt.length) add("bazaar", "listed " + listTxt.slice(0, 3).join(", "));
  }
  props().setProperty("P_" + id, JSON.stringify(cur));
  return ev;
}

// ------------------------------------------------------------------ log sheet
function logSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName("Log");
  if (!sh) {
    sh = ss.insertSheet("Log");
    sh.appendRow(["Time", "Player", "ID", "Kind", "What happened", "ms", "details"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function writeLog(events) {
  const sh = logSheet();
  const rows = events.map((e) => [new Date(e.t), e.name, e.id, e.kind, e.text, e.t, JSON.stringify(e.x || {})]);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 7).setValues(rows);
  const extra = sh.getLastRow() - 1 - KEEP_ROWS;
  if (extra > 200) sh.deleteRows(2, extra);
}

// ------------------------------------------------------------------ phone alerts (ntfy)
function notify(c, title, text) {
  if (!c.topic) return;
  try {
    UrlFetchApp.fetch("https://ntfy.sh/", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ topic: c.topic, title: title, message: text, tags: ["eyes"] }),
      muteHttpExceptions: true,
    });
  } catch (e) {}
}

// ------------------------------------------------------------------ private link for Torn Watch Geek
function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const c = getCfg();
  if (!c.secret || p.s !== c.secret) return json({ error: "wrong or old link" });
  const a = p.a || "ping";
  if (a === "watch") {
    const ids = String(p.ids || "")
      .split(",")
      .map(Number)
      .filter((x) => x > 0)
      .slice(0, MAX_PLAYERS);
    props().setProperty("WATCH", JSON.stringify(ids));
    // Forget players no longer watched.
    Object.keys(props().getProperties())
      .filter((k) => k.indexOf("P_") === 0 && ids.indexOf(+k.slice(2)) < 0)
      .forEach((k) => props().deleteProperty(k));
    return json({ ok: true, watching: ids, max: MAX_PLAYERS });
  }
  if (a === "events") {
    const since = +p.since || 0;
    const sh = logSheet();
    const last = sh.getLastRow();
    const n = Math.min(800, last - 1);
    const out = [];
    if (n > 0) {
      const rows = sh.getRange(last - n + 1, 1, n, 7).getValues();
      rows.forEach((r) => {
        const t = +r[5];
        if (t > since) {
          let x = {};
          try {
            x = JSON.parse(r[6] || "{}");
          } catch (err) {}
          out.push({ t: t, id: +r[2], name: r[1], kind: r[3], text: r[4], x: x });
        }
      });
    }
    return json({ ok: true, events: out, lastTick: c.lastTick, dead: c.dead, version: TRACKER_VERSION });
  }
  return json({ ok: true, version: TRACKER_VERSION, watching: c.watch, max: MAX_PLAYERS, lastTick: c.lastTick, dead: c.dead, running: ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === "tick") });
}
