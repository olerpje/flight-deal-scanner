/**
 * run-once.js — Flight Deal Scanner
 * Reads settings from settings.json in the repo (set via admin.html)
 */

import fetch from "node-fetch";
import nodemailer from "nodemailer";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ─── DEFAULT CONFIG (overridden by settings.json if present) ─────────────────

const DEFAULTS = {
  months: [6, 7, 8],
  minDays: 4,
  maxDays: 9,
  discountThreshold: 0.30,
  origins: ["AMS", "EIN", "BRU", "CRL", "FRA", "DUS", "CGN"],
};

const DESTINATIONS = ["ATH", "SKG", "HER", "FCO", "NAP", "PMO", "BCN", "MAD", "AGP", "LIS"];

const BASELINES = {
  // Amsterdam — expensive hub, high taxes
  "AMS-ATH": 175, "AMS-BCN": 155, "AMS-FCO": 165, "AMS-MAD": 150,
  "AMS-LIS": 160, "AMS-NAP": 170, "AMS-PMO": 175, "AMS-HER": 180,
  "AMS-SKG": 175, "AMS-AGP": 155,
  // Eindhoven — Ryanair hub but still pricier than BRU/CRL
  "EIN-ATH": 145, "EIN-BCN": 130, "EIN-MAD": 125, "EIN-FCO": 140,
  "EIN-SKG": 148, "EIN-HER": 152, "EIN-NAP": 142, "EIN-AGP": 130,
  "EIN-LIS": 148, "EIN-PMO": 150,
  // Brussels — keep low, it's a budget hub
  "BRU-ATH": 115, "BRU-BCN": 85,  "BRU-FCO": 90,  "BRU-MAD": 80,
  "BRU-LIS": 90,  "BRU-NAP": 95,  "BRU-HER": 110, "BRU-SKG": 110,
  "BRU-AGP": 88,  "BRU-PMO": 105,
  // Charleroi — cheapest airport, keep lowest
  "CRL-ATH": 105, "CRL-BCN": 75,  "CRL-FCO": 82,  "CRL-MAD": 72,
  "CRL-LIS": 80,  "CRL-NAP": 85,  "CRL-HER": 100, "CRL-SKG": 100,
  "CRL-AGP": 78,  "CRL-PMO": 95,
  // Frankfurt — expensive hub
  "FRA-ATH": 170, "FRA-BCN": 150, "FRA-FCO": 145, "FRA-MAD": 148,
  "FRA-LIS": 158, "FRA-NAP": 152, "FRA-SKG": 165, "FRA-HER": 170,
  "FRA-AGP": 150, "FRA-PMO": 160,
  // Düsseldorf
  "DUS-ATH": 162, "DUS-BCN": 140, "DUS-FCO": 138, "DUS-MAD": 135,
  "DUS-LIS": 148, "DUS-NAP": 150, "DUS-SKG": 155, "DUS-HER": 158,
  "DUS-AGP": 135, "DUS-PMO": 152,
  // Cologne
  "CGN-ATH": 155, "CGN-BCN": 132, "CGN-FCO": 130, "CGN-MAD": 128,
  "CGN-LIS": 142, "CGN-NAP": 142, "CGN-SKG": 148, "CGN-HER": 150,
  "CGN-AGP": 128, "CGN-PMO": 145,
  DEFAULT: 140,
};

// ─── LOAD SETTINGS ────────────────────────────────────────────────────────────

function loadSettings() {
  try {
    if (fs.existsSync("settings.json")) {
      const s = JSON.parse(fs.readFileSync("settings.json", "utf8"));
      console.log("   Settings loaded from settings.json");
      return { ...DEFAULTS, ...s };
    }
  } catch (e) {
    console.log("   Could not read settings.json, using defaults");
  }
  console.log("   Using default settings");
  return { ...DEFAULTS };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function buildBookingUrl(origin, destination, departDate, returnDate) {
  const dep = departDate ? new Date(departDate).toISOString().slice(0, 10) : null;
  const ret = returnDate ? new Date(returnDate).toISOString().slice(0, 10) : null;
  if (dep && ret) {
    return `https://www.google.com/travel/flights?q=Flights+from+${origin}+to+${destination}+on+${dep}+returning+${ret}`;
  } else if (dep) {
    return `https://www.google.com/travel/flights?q=Flights+from+${origin}+to+${destination}+on+${dep}`;
  }
  return `https://www.google.com/travel/flights?q=Flights+from+${origin}+to+${destination}`;
}

function daysBetween(date1, date2) {
  if (!date1 || !date2) return null;
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.round(Math.abs(d2 - d1) / (1000 * 60 * 60 * 24));
}

// ─── EMAIL SETUP ─────────────────────────────────────────────────────────────

const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

// ─── FETCH CHEAP FLIGHTS ─────────────────────────────────────────────────────

async function fetchCheapFlights(origin, settings) {
  const deals = [];

  for (const destination of DESTINATIONS) {
    const routeKey = `${origin}-${destination}`;
    const baseline = BASELINES[routeKey] || BASELINES.DEFAULT;
    const threshold = baseline * (1 - settings.discountThreshold);

    const url = new URL("https://api.travelpayouts.com/v1/prices/cheap");
    url.searchParams.set("token", process.env.TRAVELPAYOUTS_TOKEN);
    url.searchParams.set("origin", origin);
    url.searchParams.set("destination", destination);
    url.searchParams.set("currency", "eur");

    try {
      const res = await fetch(url.toString());
      const json = await res.json();
      if (!json.success) { continue; }

      for (const [dest, data] of Object.entries(json.data || {})) {
        for (const [, flight] of Object.entries(data)) {

          // Filter by month
          const depMonth = new Date(flight.departure_at).getMonth() + 1;
          if (!settings.months.includes(depMonth)) continue;

          // Filter by trip duration
          const tripDays = daysBetween(flight.departure_at, flight.return_at);
          if (tripDays !== null && (tripDays < settings.minDays || tripDays > settings.maxDays)) continue;

          // Filter by price threshold
          if (flight.price > threshold) continue;

          console.log(`  [${origin}→${dest}] €${flight.price} | ${flight.departure_at?.slice(0,10)} → ${flight.return_at?.slice(0,10)} (${tripDays}d) | threshold €${Math.round(threshold)}`);

          deals.push({
            origin,
            destination: dest,
            price: flight.price,
            departDate: flight.departure_at,
            returnDate: flight.return_at,
            airline: flight.airline,
            transfers: flight.transfers,
            tripDays,
          });
        }
      }
    } catch (err) {
      console.error(`  [${origin}→${destination}] Error:`, err.message);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return deals;
}

// ─── AI DEAL VALIDATION ──────────────────────────────────────────────────────

async function validateWithClaude(deal, settings) {
  const routeKey = `${deal.origin}-${deal.destination}`;
  const baseline = BASELINES[routeKey] || BASELINES.DEFAULT;

  const prompt = `You are a flight deal expert. Evaluate this deal.

Route: ${deal.origin} → ${deal.destination}
Price: €${deal.price} (${deal.transfers === 0 ? "direct" : deal.transfers + " stop(s)"})
Airline: ${deal.airline}
Departure: ${deal.departDate?.slice(0,10)}
Return: ${deal.returnDate?.slice(0,10) || "not specified"}
Trip duration: ${deal.tripDays !== null ? deal.tripDays + " days" : "unknown"}
Typical price: €${baseline}
Discount vs typical: ${Math.round((1 - deal.price/baseline)*100)}%

Score: 9-10 error fare (>70% off), 7-8 excellent (50-70% off), 5-6 good (30-50% off), 1-4 mediocre.

Respond ONLY with valid JSON:
{"isDeal": true, "score": 8, "label": "Excellent Deal", "reason": "one sentence", "urgency": "Book in next 2h"}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.error("Claude error:", err.message);
    return { isDeal: false };
  }
}

// ─── TELEGRAM (per deal) ─────────────────────────────────────────────────────

async function sendTelegram(deal, ai) {
  const url = buildBookingUrl(deal.origin, deal.destination, deal.departDate, deal.returnDate);
  const emoji = ai.score >= 9 ? "🔥" : ai.score >= 7 ? "⭐" : "✅";
  const dep = deal.departDate?.slice(0, 10) || "?";
  const ret = deal.returnDate?.slice(0, 10);

  const msg = [
    `✈️ *FLIGHT DEAL*`,
    ``,
    `🛫 *${deal.origin} → ${deal.destination}*`,
    `💶 *€${deal.price}* ${deal.transfers === 0 ? "(direct)" : `(${deal.transfers} stop)`}`,
    `📅 ${dep}${ret ? " → " + ret : ""}${deal.tripDays ? " (" + deal.tripDays + " days)" : ""}`,
    `✈️ ${deal.airline}`,
    `🏷️ ${emoji} ${ai.label} — Score ${ai.score}/10`,
    ``,
    `📝 _${ai.reason}_`,
    `⏰ ${ai.urgency}`,
    ``,
    `👉 [Book on Google Flights](${url})`,
  ].join("\n");

  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" }),
  });
  const d = await r.json();
  if (d.ok) console.log(`[TELEGRAM ✓] ${deal.origin}→${deal.destination} €${deal.price}`);
  else console.error(`[TELEGRAM ✗]`, JSON.stringify(d));
}

// ─── DIGEST EMAIL ────────────────────────────────────────────────────────────

async function sendDigestEmail(confirmedDeals, settings) {
  const rows = confirmedDeals.map(({ deal, ai }) => {
    const emoji = ai.score >= 9 ? "🔥" : ai.score >= 7 ? "⭐" : "✅";
    const url = buildBookingUrl(deal.origin, deal.destination, deal.departDate, deal.returnDate);
    const dep = deal.departDate?.slice(0, 10) || "?";
    const ret = deal.returnDate?.slice(0, 10) || "—";
    const baseline = BASELINES[`${deal.origin}-${deal.destination}`] || BASELINES.DEFAULT;
    const savings = baseline - deal.price;
    const labelColor = ai.score >= 9 ? "#ec4899" : ai.score >= 7 ? "#f97316" : "#00c2a8";

    return `
    <tr>
      <td style="padding:14px 12px;border-bottom:1px solid #1e2030;vertical-align:top">
        <div style="font-size:15px;font-weight:bold;color:#fff">${deal.origin} → ${deal.destination}</div>
        <div style="font-size:11px;color:#8892a4;margin-top:2px">${deal.airline} · ${deal.transfers === 0 ? "Direct" : deal.transfers + " stop"}</div>
      </td>
      <td style="padding:14px 12px;border-bottom:1px solid #1e2030;vertical-align:top">
        <div style="font-size:20px;font-weight:bold;color:#00c2a8">€${deal.price}</div>
        ${savings > 0 ? `<div style="font-size:11px;color:#7c6ff7">save ~€${savings}</div>` : ""}
      </td>
      <td style="padding:14px 12px;border-bottom:1px solid #1e2030;vertical-align:top">
        <div style="font-size:12px;color:#e8e4d9">Out: ${dep}</div>
        <div style="font-size:12px;color:#e8e4d9">Ret: ${ret}</div>
        ${deal.tripDays ? `<div style="font-size:11px;color:#8892a4">${deal.tripDays} days</div>` : ""}
      </td>
      <td style="padding:14px 12px;border-bottom:1px solid #1e2030;vertical-align:top">
        <span style="background:${labelColor}20;border:1px solid ${labelColor};color:${labelColor};padding:3px 7px;border-radius:4px;font-size:11px;font-weight:bold">${emoji} ${ai.label}</span>
        <div style="font-size:11px;color:#5a6474;margin-top:4px">${ai.urgency}</div>
      </td>
      <td style="padding:14px 12px;border-bottom:1px solid #1e2030;vertical-align:top">
        <a href="${url}" style="background:#00c2a8;color:#000;padding:8px 12px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:12px;white-space:nowrap">Book →</a>
      </td>
    </tr>`;
  }).join("");

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const activeMonths = settings.months.map(m => monthNames[m-1]).join(", ");

  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0f;font-family:Arial,sans-serif">
<div style="max-width:750px;margin:0 auto;padding:32px 24px">
  <div style="font-size:10px;letter-spacing:0.3em;color:#00c2a8;text-transform:uppercase;margin-bottom:8px">Flight Deal Scanner</div>
  <h1 style="font-size:26px;color:#e8e4d9;margin:0 0 4px">✈️ ${confirmedDeals.length} Deal${confirmedDeals.length > 1 ? "s" : ""} Found</h1>
  <p style="color:#8892a4;font-size:12px;margin:0 0 6px">${new Date().toUTCString()}</p>
  <p style="color:#5a6474;font-size:11px;margin:0 0 24px">Months: ${activeMonths} · Trip: ${settings.minDays}–${settings.maxDays} days · Min discount: ${Math.round(settings.discountThreshold*100)}% below average</p>
  <div style="background:#0d1117;border:1px solid #1e2030;border-radius:12px;overflow:hidden">
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#0f1420">
          <th style="padding:10px 12px;text-align:left;color:#4a5568;font-size:10px;text-transform:uppercase;letter-spacing:0.1em">Route</th>
          <th style="padding:10px 12px;text-align:left;color:#4a5568;font-size:10px;text-transform:uppercase;letter-spacing:0.1em">Price</th>
          <th style="padding:10px 12px;text-align:left;color:#4a5568;font-size:10px;text-transform:uppercase;letter-spacing:0.1em">Dates</th>
          <th style="padding:10px 12px;text-align:left;color:#4a5568;font-size:10px;text-transform:uppercase;letter-spacing:0.1em">Rating</th>
          <th style="padding:10px 12px;text-align:left;color:#4a5568;font-size:10px;text-transform:uppercase;letter-spacing:0.1em">Book</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div style="color:#4a5568;font-size:11px;text-align:center;margin-top:24px">Flight Deal Scanner · GitHub Actions · Every 2 hours · <a href="https://${process.env.GH_USER || "your-username"}.github.io/${process.env.GH_REPO || "flight-deal-scanner"}/admin.html" style="color:#00c2a8">Change settings</a></div>
</div></body></html>`;

  await mailer.sendMail({
    from: `"Flight Deals" <${process.env.GMAIL_USER}>`,
    to: process.env.ALERT_EMAIL,
    subject: `✈️ ${confirmedDeals.length} deal${confirmedDeals.length > 1 ? "s" : ""} found — ${new Date().toLocaleDateString()}`,
    html,
  });
  console.log(`[EMAIL DIGEST ✓] ${confirmedDeals.length} deals sent`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const settings = loadSettings();

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  console.log(`\n✈️  Flight Deal Scanner — ${new Date().toISOString()}`);
  console.log(`   Months: ${settings.months.map(m => monthNames[m-1]).join(", ")}`);
  console.log(`   Trip duration: ${settings.minDays}–${settings.maxDays} days`);
  console.log(`   Min discount: ${Math.round(settings.discountThreshold*100)}% below average`);
  console.log(`   Origins: ${settings.origins.join(", ")}`);
  console.log(`   TELEGRAM loaded: ${!!process.env.TELEGRAM_BOT_TOKEN} | GMAIL loaded: ${!!process.env.GMAIL_USER}\n`);

  const allDeals = [];
  for (const origin of settings.origins) {
    console.log(`   Checking ${origin}...`);
    const deals = await fetchCheapFlights(origin, settings);
    console.log(`   → ${deals.length} potential deals\n`);
    allDeals.push(...deals);
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log(`   Total matching deals: ${allDeals.length}`);

  if (allDeals.length === 0) {
    console.log("   No deals this run. Exiting.\n");
    process.exit(0);
  }

  console.log("   Running AI filter...\n");

  const confirmedDeals = [];
  let alertsSent = 0;

  for (const deal of allDeals) {
    const ai = await validateWithClaude(deal, settings);
    const emoji = ai.isDeal ? (ai.score >= 9 ? "🔥" : "⭐") : "✗";
    console.log(`   ${emoji} ${deal.origin}→${deal.destination} €${deal.price} | ${deal.tripDays}d | score:${ai.score} | isDeal:${ai.isDeal}`);

    if (ai.isDeal) {
      await sendTelegram(deal, ai);
      confirmedDeals.push({ deal, ai });
      alertsSent++;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  if (confirmedDeals.length > 0) {
    await sendDigestEmail(confirmedDeals, settings);
  }

  console.log(`\n✅ Done. ${alertsSent} alert(s) sent.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
