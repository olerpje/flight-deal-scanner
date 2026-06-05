/**
 * run-once.js — Flight Deal Scanner with Supabase
 * - Reads settings from settings.json
 * - Deduplicates deals via Supabase
 * - Sends instant alerts to premium subscribers
 * - Sends delayed (24h) email to free subscribers
 */

import fetch from "node-fetch";
import nodemailer from "nodemailer";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ─── SUPABASE CLIENT ──────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabase(method, table, body = null, params = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : "",
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error: ${err}`);
  }
  return res.status === 204 ? null : res.json();
}

// ─── DEFAULT CONFIG ───────────────────────────────────────────────────────────

const DEFAULTS = {
  months: [6, 7, 8],
  minDays: 4,
  maxDays: 9,
  discountThreshold: 0.30,
  origins: ["AMS", "EIN", "BRU", "CRL", "FRA", "DUS", "CGN"],
};

const DESTINATIONS = ["ATH", "SKG", "HER", "FCO", "NAP", "PMO", "BCN", "MAD", "AGP", "LIS"];

const BASELINES = {
  "AMS-ATH": 175, "AMS-BCN": 155, "AMS-FCO": 165, "AMS-MAD": 150,
  "AMS-LIS": 160, "AMS-NAP": 170, "AMS-PMO": 175, "AMS-HER": 180,
  "AMS-SKG": 175, "AMS-AGP": 155,
  "EIN-ATH": 145, "EIN-BCN": 130, "EIN-MAD": 125, "EIN-FCO": 140,
  "EIN-SKG": 148, "EIN-HER": 152, "EIN-NAP": 142, "EIN-AGP": 130,
  "EIN-LIS": 148, "EIN-PMO": 150,
  "BRU-ATH": 115, "BRU-BCN": 85,  "BRU-FCO": 90,  "BRU-MAD": 80,
  "BRU-LIS": 90,  "BRU-NAP": 95,  "BRU-HER": 110, "BRU-SKG": 110,
  "BRU-AGP": 88,  "BRU-PMO": 105,
  "CRL-ATH": 105, "CRL-BCN": 75,  "CRL-FCO": 82,  "CRL-MAD": 72,
  "CRL-LIS": 80,  "CRL-NAP": 85,  "CRL-HER": 100, "CRL-SKG": 100,
  "CRL-AGP": 78,  "CRL-PMO": 95,
  "FRA-ATH": 170, "FRA-BCN": 150, "FRA-FCO": 145, "FRA-MAD": 148,
  "FRA-LIS": 158, "FRA-NAP": 152, "FRA-SKG": 165, "FRA-HER": 170,
  "FRA-AGP": 150, "FRA-PMO": 160,
  "DUS-ATH": 162, "DUS-BCN": 140, "DUS-FCO": 138, "DUS-MAD": 135,
  "DUS-LIS": 148, "DUS-NAP": 150, "DUS-SKG": 155, "DUS-HER": 158,
  "DUS-AGP": 135, "DUS-PMO": 152,
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
  } catch (e) {}
  console.log("   Using default settings");
  return { ...DEFAULTS };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function buildBookingUrl(origin, destination, departDate, returnDate) {
  const dep = departDate ? new Date(departDate).toISOString().slice(0, 10) : null;
  const ret = returnDate ? new Date(returnDate).toISOString().slice(0, 10) : null;
  if (dep && ret) return `https://www.google.com/travel/flights?q=Flights+from+${origin}+to+${destination}+on+${dep}+returning+${ret}`;
  if (dep) return `https://www.google.com/travel/flights?q=Flights+from+${origin}+to+${destination}+on+${dep}`;
  return `https://www.google.com/travel/flights?q=Flights+from+${origin}+to+${destination}`;
}

function daysBetween(date1, date2) {
  if (!date1 || !date2) return null;
  return Math.round(Math.abs(new Date(date2) - new Date(date1)) / (1000 * 60 * 60 * 24));
}

// ─── DEDUPLICATION ────────────────────────────────────────────────────────────

async function isDuplicate(deal) {
  const route = `${deal.origin}-${deal.destination}`;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const rows = await supabase("GET", "sent_deals", null, {
      "route": `eq.${route}`,
      "price": `gte.${deal.price - 5}`,
      "sent_at": `gte.${since}`,
      "limit": "1"
    });
    return rows && rows.length > 0;
  } catch (e) {
    console.error("Dedup check failed:", e.message);
    return false;
  }
}

async function markAsSent(deal) {
  const route = `${deal.origin}-${deal.destination}`;
  try {
    await supabase("POST", "sent_deals", {
      route,
      price: deal.price,
      depart_date: deal.departDate?.slice(0, 10),
      return_date: deal.returnDate?.slice(0, 10),
      airline: deal.airline,
    });
  } catch (e) {
    console.error("Mark as sent failed:", e.message);
  }
}

// ─── EMAIL SETUP ─────────────────────────────────────────────────────────────

const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

// ─── FETCH SUBSCRIBERS ────────────────────────────────────────────────────────

async function getSubscribers() {
  try {
    const rows = await supabase("GET", "subscribers", null, { "active": "eq.true" });
    return rows || [];
  } catch (e) {
    console.error("Failed to fetch subscribers:", e.message);
    return [];
  }
}

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
      if (!json.success) continue;

      for (const [dest, data] of Object.entries(json.data || {})) {
        for (const [, flight] of Object.entries(data)) {
          const depMonth = new Date(flight.departure_at).getMonth() + 1;
          if (!settings.months.includes(depMonth)) continue;
          const tripDays = daysBetween(flight.departure_at, flight.return_at);
          if (tripDays !== null && (tripDays < settings.minDays || tripDays > settings.maxDays)) continue;
          if (flight.price > threshold) continue;

          console.log(`  [${origin}→${dest}] €${flight.price} | ${flight.departure_at?.slice(0,10)} → ${flight.return_at?.slice(0,10)} (${tripDays}d)`);
          deals.push({
            origin, destination: dest, price: flight.price,
            departDate: flight.departure_at, returnDate: flight.return_at,
            airline: flight.airline, transfers: flight.transfers, tripDays,
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

// ─── AI VALIDATION ────────────────────────────────────────────────────────────

async function validateWithClaude(deal) {
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
Discount: ${Math.round((1 - deal.price/baseline)*100)}%
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
    return { isDeal: false };
  }
}

// ─── BUILD EMAIL HTML ─────────────────────────────────────────────────────────

function buildEmailHtml(confirmedDeals, settings, tier = "premium") {
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
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

  const tierBadge = tier === "premium"
    ? `<span style="background:#f9731620;border:1px solid #f97316;color:#f97316;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold">⭐ PREMIUM</span>`
    : `<span style="background:#1e203080;border:1px solid #4a5568;color:#8892a4;padding:2px 8px;border-radius:4px;font-size:11px">FREE</span>`;

  const freeNote = tier === "free"
    ? `<div style="background:#f9731610;border:1px solid #f9731640;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:12px;color:#f97316">
        ⏰ These deals were found 24h ago. <a href="https://olerpje.github.io/flight-deal-scanner/signup.html" style="color:#f97316;font-weight:bold">Upgrade to Premium (€9/mo)</a> to get instant alerts.
       </div>` : "";

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0f;font-family:Arial,sans-serif">
<div style="max-width:750px;margin:0 auto;padding:32px 24px">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
    <div style="font-size:10px;letter-spacing:0.3em;color:#00c2a8;text-transform:uppercase">Flight Deal Scanner</div>
    ${tierBadge}
  </div>
  <h1 style="font-size:26px;color:#e8e4d9;margin:0 0 4px">✈️ ${confirmedDeals.length} Deal${confirmedDeals.length > 1 ? "s" : ""} Found</h1>
  <p style="color:#8892a4;font-size:12px;margin:0 0 20px">${new Date().toUTCString()}</p>
  ${freeNote}
  <div style="background:#0d1117;border:1px solid #1e2030;border-radius:12px;overflow:hidden">
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#0f1420">
          <th style="padding:10px 12px;text-align:left;color:#4a5568;font-size:10px;text-transform:uppercase">Route</th>
          <th style="padding:10px 12px;text-align:left;color:#4a5568;font-size:10px;text-transform:uppercase">Price</th>
          <th style="padding:10px 12px;text-align:left;color:#4a5568;font-size:10px;text-transform:uppercase">Dates</th>
          <th style="padding:10px 12px;text-align:left;color:#4a5568;font-size:10px;text-transform:uppercase">Rating</th>
          <th style="padding:10px 12px;text-align:left;color:#4a5568;font-size:10px;text-transform:uppercase">Book</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div style="color:#4a5568;font-size:11px;text-align:center;margin-top:24px">
    Flight Deal Scanner · Checks every hour · <a href="https://olerpje.github.io/flight-deal-scanner/signup.html" style="color:#00c2a8">Manage subscription</a>
  </div>
</div></body></html>`;
}

// ─── SEND TELEGRAM ────────────────────────────────────────────────────────────

async function sendTelegramToSubscriber(deal, ai, chatId) {
  const url = buildBookingUrl(deal.origin, deal.destination, deal.departDate, deal.returnDate);
  const emoji = ai.score >= 9 ? "🔥" : ai.score >= 7 ? "⭐" : "✅";
  const msg = [
    `✈️ *FLIGHT DEAL — PREMIUM*`,
    ``,
    `🛫 *${deal.origin} → ${deal.destination}*`,
    `💶 *€${deal.price}* ${deal.transfers === 0 ? "(direct)" : `(${deal.transfers} stop)`}`,
    `📅 ${deal.departDate?.slice(0,10)}${deal.returnDate ? " → " + deal.returnDate.slice(0,10) : ""}${deal.tripDays ? " (" + deal.tripDays + "d)" : ""}`,
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
    body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "Markdown" }),
  });
  const d = await r.json();
  if (!d.ok) console.error(`[TELEGRAM ✗] chat_id ${chatId}:`, d.description);
  else console.log(`[TELEGRAM ✓] chat_id ${chatId}`);
}

// ─── SEND EMAIL TO SUBSCRIBER ─────────────────────────────────────────────────

async function sendEmailToSubscriber(email, deals, tier) {
  const html = buildEmailHtml(deals, {}, tier);
  await mailer.sendMail({
    from: `"✈️ Flight Deals" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `✈️ ${deals.length} flight deal${deals.length > 1 ? "s" : ""} found${tier === "free" ? " (free tier)" : ""}`,
    html,
  });
  console.log(`[EMAIL ✓] ${tier} → ${email} (${deals.length} deals)`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const settings = loadSettings();
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  console.log(`\n✈️  Flight Deal Scanner — ${new Date().toISOString()}`);
  console.log(`   Months: ${settings.months.map(m => monthNames[m-1]).join(", ")}`);
  console.log(`   Trip: ${settings.minDays}–${settings.maxDays} days | Discount: ${Math.round(settings.discountThreshold*100)}%+`);
  console.log(`   Origins: ${settings.origins.join(", ")}\n`);

  // 1. Fetch all deals
  const allDeals = [];
  for (const origin of settings.origins) {
    console.log(`   Checking ${origin}...`);
    const deals = await fetchCheapFlights(origin, settings);
    console.log(`   → ${deals.length} potential deals\n`);
    allDeals.push(...deals);
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log(`   Total matching: ${allDeals.length}`);
  if (allDeals.length === 0) { console.log("   No deals. Exiting.\n"); process.exit(0); }

  // 2. AI filter + deduplication
  console.log("   Running AI filter + deduplication...\n");
  const newDeals = [];

  for (const deal of allDeals) {
    const ai = await validateWithClaude(deal);
    if (!ai.isDeal) {
      console.log(`   ✗ ${deal.origin}→${deal.destination} €${deal.price} | score:${ai.score}`);
      continue;
    }

    const duplicate = await isDuplicate(deal);
    if (duplicate) {
      console.log(`   ⟳ ${deal.origin}→${deal.destination} €${deal.price} — already sent, skipping`);
      continue;
    }

    const emoji = ai.score >= 9 ? "🔥" : "⭐";
    console.log(`   ${emoji} NEW: ${deal.origin}→${deal.destination} €${deal.price} | score:${ai.score}`);
    newDeals.push({ deal, ai });
    await markAsSent(deal);
    await new Promise((r) => setTimeout(r, 400));
  }

  if (newDeals.length === 0) {
    console.log("\n   No new deals (all already sent). Exiting.\n");
    process.exit(0);
  }

  console.log(`\n   ${newDeals.length} new deals to send!\n`);

  // 3. Send to owner (you) always
  await sendEmailToSubscriber(process.env.ALERT_EMAIL, newDeals, "premium");
  if (process.env.TELEGRAM_CHAT_ID) {
    for (const { deal, ai } of newDeals) {
      await sendTelegramToSubscriber(deal, ai, process.env.TELEGRAM_CHAT_ID);
    }
  }

  // 4. Send to subscribers
  const subscribers = await getSubscribers();
  console.log(`\n   Subscribers: ${subscribers.length}`);

  for (const sub of subscribers) {
    // Filter deals relevant to this subscriber's airports
    const relevantDeals = sub.origins?.length > 0
      ? newDeals.filter(({ deal }) =>
          sub.origins.includes(deal.origin) &&
          (!sub.destinations?.length || sub.destinations.includes(deal.destination))
        )
      : newDeals;

    if (relevantDeals.length === 0) continue;

    if (sub.tier === "premium") {
      // Instant alerts — email + telegram based on preference
      if (sub.alert_method === "email" || sub.alert_method === "both") {
        await sendEmailToSubscriber(sub.email, relevantDeals, "premium");
      }
      if ((sub.alert_method === "telegram" || sub.alert_method === "both") && sub.telegram_chat_id) {
        for (const { deal, ai } of relevantDeals) {
          await sendTelegramToSubscriber(deal, ai, sub.telegram_chat_id);
        }
      }
    } else {
      // Free tier — email only, deals are already 24h deduplicated so this
      // naturally creates the delay since we only send NEW deals
      await sendEmailToSubscriber(sub.email, relevantDeals, "free");
    }
  }

  console.log(`\n✅ Done. ${newDeals.length} new deal(s) sent to ${subscribers.length} subscriber(s).\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
