# Torn Watch Geek

A Torn userscript for **Torn PDA** (also works in Tampermonkey). It does two jobs:

- **👁 Watch** players: online/offline, hospital, jail, flights with landing times, and new bazaar or Item Market listings.
- **🎯 Hunt** for mug targets: live bazaar sales and your own advanced search (including inactive workers in high-paying companies). Every result shows estimated battle stats and a win chance.

It only reads data. Profile, Attack and Bazaar buttons just open the page. It never attacks, buys, sells or clicks anything for you.

## Install

**Torn PDA:** Settings → Userscripts → **+** → Remote load/update → paste this link → Configure:

```
https://raw.githubusercontent.com/SarcasticGeekJr/torn-watch-geek/main/torn-watch-geek.user.js
```

- Set injection time to **END**.
- When PDA asks about the API key, tap **Add** to use your PDA key. A **Public** key is enough.
- For battle stats, register your key once at **ffscouter.com**. It's the same free service the FF Scouter script uses.

**Tampermonkey:** open the link above and tap Install.

Updates: Torn PDA checks when the app starts (or Settings → Userscripts → ⟳). Tampermonkey checks about daily. Your version is in ⚙ → About.

## What it does

### 👁 Watch
- Open someone's profile, tap the 👁 button, then **⭐ Watch this player**. You can also type their ID.
- Each player shows a 🟢 online / 🟡 idle / ⚪ offline dot, their status and "active 3m ago".
- Hospital and jail show the time left.
- **Flights:**
  - Take-off seen: `✈ Japan · lands between 14:10 and 15:50`. Tickets that would already have landed are ruled out as time passes.
  - Ticket known: `✈ Japan · WLT · lands between 15:19 and 15:27 (most likely ~15:23)`. The ticket comes from the plane type Torn shows for the flight, or from what it learned on a past flight. It's a range because take-off is only known to within one check, and real flights vary up to about 3% from the table.
  - **Learns real flight times:** every landing it (or the background tracker) times well, it saves how long that route + ticket really took. After 2 real flights the range is based on them and narrower: `(based on 3 real flights)`.
  - **⏳ Landing window starts:** an alert at the start of the range, not the middle (⚙ → Alerts). In Torn PDA it also sets a phone notification for that time, so it reaches you even if Torn PDA is closed.
  - **Fast check before landing:** from 5 minutes before the range starts until it ends, that player is checked every 10 seconds (⚙ → API use; on by default) instead of every minute, so you see the landing within seconds. It slows down by itself so it never goes over your cap.
  - Take-off not seen (started watching mid-flight): `✈ Switzerland · Landing time unknown` with `Already flying when tracking started. Latest possible landing: 8:11 pm. Tap to enter take-off time.`
  - Take-off not seen, but they were seen on the ground earlier (by the script, or a landing logged by the background tracker): `✈ Torn → Switzerland · lands between 9:34 pm and 9:42 pm` with `Took off between 7:38 pm and 7:46 pm`.
  - If you know when they took off, enter it on their page ("took off at…" or "… minutes ago") and the landing time is worked out from that.
  - It learns which plane type means which ticket from real flights.
  - Flight times are the same table Torn PDA uses (Torn wiki).
- **Bazaar:** checks their bazaar every 5 min. `listed 50× Xanax @ $830k` · `sold or removed 20× Xanax (~$16.6M)`
- **Item Market:** when you open an item on the Item Market, a watched player's listing gets a yellow outline and goes in their log.
- Pop-up alerts (and vibration) for the things you pick in ⚙. Everything also goes in **🔔 Feed**.

### 🎯 Hunt
**📡 Live sales:** a list that keeps updating with sales as they're spotted.
- Tap **▶ Start live**. The script checks a **pool of big sellers** one after another: their bazaar and status in one API call each.
- The pool fills itself. **Beatable sellers** (default): mid-size bazaars found on TornW3B ($5M–$1B listed), leaving out anyone who is 🔴 Avoid for you. **Biggest sellers**: Torn's weekly top-earning bazaars and the biggest TornW3B sellers. You can add anyone.
- 🔥 means they sold **while away**: offline since the sale, flying, or abroad anywhere except the Cayman Islands (which has a bank). The money is probably still on hand.
- Each 🔥 row shows the total unbanked since they were last seen, plus a mug estimate. When they come back, the row turns grey ("probably banked").
- Filters: min and max amount (quick chips: $500k / $1M / $5M / $10M), only 🔥, win chance, item. A line above the list says which filters are on.
- 🔥 alert (pop-up and vibration) when someone's unbanked total passes your alert amount. Alerts follow the list's filters (min, max, win chance, item).
- Speed: the default is 25 API calls a minute for live, and each seller is checked at most every 30 seconds. Torn **delays bazaar data on purpose** to slow down mug bots, so sales show up a little after they happen. Times shown are Torn's.
- Watched players' bazaar sales and TornW3B sales also show up here.

**🔎 Search:** your own advanced search, no Donator Pack needed.
- **Sleeping workers** are part of Search. Pick company types (for example Oil Rig and Mining Corporation) and Search first reads those companies' worker lists, adds every worker, then filters them. By default it reads a mix of 40 companies of all sizes, because top companies fire inactive staff fast. Each worker shows days inactive and a rough "unbanked pay" guess (wages land as cash on hand). Sort by "Most unbanked pay" to see the best ones first.
- First tap **➕ Find more players**. It builds a players list on your phone from the Hall of Fame (networth, offences, level) and faction member lists, 100 players per API call.
- Filters: name, faction, level, inactive days, days old, offences, networth, gender, property, company type, company stars, max battle stats, win chance, Okay only, hide 7★ clothing store workers (−75% mug), hide players you mugged recently.
- Quick filters run instantly on the saved list. The top results then get a fresh profile check (1 API call each) for status, gender, property, company and stars.

### 🧠 Learns from your mugs
- Open attacks with the script's **Attack** button. It remembers how much cash it guessed the target had.
- After the mug, it reads the amount from the attack page (while you're looking at it), and from your events if you add a **Limited** key in ⚙ Settings.
- It works out how much they really had and corrects its guesses by itself, separately for worker pay and for live sales. It starts after 3 mugs and uses the middle value of the last 15, so one odd mug can't throw it off.
- ⚙ Settings → Learning shows what it learned (for example `Worker pay guesses × 0.13 (from 3 mugs)`), your recent mugs, and a Reset button.

### API key terms (Torn ToS)
| Data storage | Data sharing | Purpose of use | Key storage & sharing | Key access level |
|---|---|---|---|---|
| Only locally | Nobody (player IDs you look up go to FF Scouter, if turned on) | Competitive advantage: tracking players and finding mug targets | Stored locally / Shared with FF Scouter (can be turned off) | Public (Limited only used to read your own battle stats and your own events, for mug results) |

- FF Scouter terms: [ffscouter.com](https://ffscouter.com). Torn Stats (optional): [tornstats.com](https://www.tornstats.com).
- If Torn says the key is wrong, paused or disabled, the script stops using it until you change it.
- It reads only Torn pages you are looking at, and makes no other requests to torn.com.

### Stats and win chance
- Estimated battle stats and Fair Fight come from **FF Scouter**.
- Optional **Torn Stats** key: shows real spy reports on a player's page when your faction has one.
- Win chance: 🟢 Easy · 🟡 Likely · 🟠 Risky · 🔴 Avoid. Add your total battle stats in ⚙ for a better guess.
- Tap **💰** on a target after a mug. They're hidden from Hunt for a few days.

## Background tracker

A small free script in **your own Google account** that checks your watched players **every minute, 24/7**, even when Torn is closed or your phone is off.

- Logs every change with the exact time in a Google Sheet: took off, landed, hospital, jail, online, bazaar sales.
- Optional phone alerts through the free **ntfy** app.
- Torn Watch Geek reads the log when you open Torn, so take-off and landing times are exact and nothing is missed.
- Up to 12 watched players (Google's free limits). Uses 1 Torn API call per player per minute.
- Your API key is stored only in your Google account and only sent to api.torn.com.

### Setup (about 5 minutes, once)
1. Open **sheets.google.com** and create a blank sheet. Name it "Torn Tracker".
2. Menu **Extensions → Apps Script**. Delete what's there.
3. Open this link, select all the text, copy it, paste it into Apps Script, and tap **Save** (💾):
   `https://raw.githubusercontent.com/SarcasticGeekJr/torn-watch-geek/main/tracker/Code.gs`
4. Go back to the sheet and reload it. A **🛰 Torn Tracker** menu appears (it can take a few seconds).
5. **🛰 Torn Tracker → Setup.** Google asks for permission: tap **Continue**, choose your account, then **Advanced → Go to Torn Tracker (unsafe) → Allow**. ("Unsafe" only means Google hasn't reviewed your own private script.)
6. In the Setup panel: paste your API key, keep or change the ntfy topic, tick the alerts you want, tap **Save and start tracking**.
7. In Apps Script: **Deploy → New deployment** → gear ⚙ → **Web app**. Execute as: **Me**. Who has access: **Anyone**. Tap **Deploy** (allow again if asked).
8. Back in the sheet: **🛰 Torn Tracker → Show my link**. Copy the link.
   - The link must end in **/exec?s=…**. If it ends in **/dev**, that's Google's test link and won't work from Torn PDA: use **Deploy → Manage deployments → Web app URL** (ends in /exec) and add the `?s=…` part.
   - Test it by opening the link in a browser: it should show `{"ok":true,…}`.
9. In Torn Watch Geek: **⚙ Settings → Background tracker link** → paste → **Check tracker**. It should say ✅ Connected.
10. Phone alerts (optional): install **ntfy** from the app store, tap **+**, and subscribe to the topic name shown in Setup.

The watched players list is sent to the tracker automatically from Torn Watch Geek.

## API use
- All Torn API calls go through one queue, capped at **30 a minute** by default (change it in ⚙). Torn allows 100 a minute shared by all your tools. The Watch tab and ⚙ → API use show the calls made in the last minute, live.
- Torn keeps API answers in a cache for up to 30 seconds (repeat calls in that time are free but return the same data). Fast checks skip that cache, so each one is a real call.
- Watched players: 1 call per player per check (default every 60s) plus 1 per bazaar check (every 5 min).
- Live sales: 25 calls a minute while it's running (pause it any time). Search and Sleeping workers only use calls when you tap a button.
- It only runs while Torn is open. It can't alert you when the app is closed.

## Limits
- The Torn API doesn't say who listed on the Item Market. Sellers are only seen on Item Market pages you open.
- The Torn API doesn't give landing times. They're worked out from when the flight was first seen.
- Battle stats, wages and cash on hand are estimates.
- Search only finds players the script has seen (Hall of Fame, factions, companies, sellers). Torn has no "list every player" option.

## Data sources
- Torn API v1: `user` profile and bazaar, `company` companies and profile, `torn` companies.
- Torn API v2: `torn/hof`, `faction/{id}/members`, `market/bazaar`.
- [FF Scouter](https://ffscouter.com) for stat estimates.
- [Torn Stats](https://www.tornstats.com) spies (optional).
- [TornW3B](https://weav3r.dev) bazaar listings.

Settings and saved data live in your browser's localStorage under `twg_`. Reinstalling keeps them.
