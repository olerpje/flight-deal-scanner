/**
 * run-once.js
 * Single-execution version of the scanner — used by GitHub Actions.
 * GitHub handles the scheduling; this just runs the scan and exits.
 */

import fetch from "node-fetch";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {
  discountThreshold: 0.30, // alert if 30%+ below average
  origins: ["AMS", "EIN", "BRU", "CRL", "FRA", "DUS", "CGN"],
  destinations: ["ATH", "SKG", "HER", "FCO", "NAP", "PMO", "BCN", "MAD", "AGP", "LIS"],
  baselines: {
    "AMS-ATH": 110, "AMS-BCN": 90,  "AMS-FCO": 95,  "AMS-MAD": 85,
    "AMS-LIS": 95,  "AMS-NAP": 100, "AMS-PMO": 105, "AMS-HER": 115,
    "AMS-SKG": 110, "AMS-AGP": 90,
    "BRU-ATH": 115, "BRU-BCN": 85,  "BRU-FCO": 90,  "BRU-MAD": 80,
    "BRU-LIS": 90,  "BRU-NAP": 95,  "BRU-HER": 110,
    "FRA-ATH": 120, "FRA-BCN": 95,  "FRA-FCO": 85,  "FRA-MAD": 90,
    "FRA-LIS": 100, "FRA-NAP": 90,
    "DUS-ATH": 115, "DUS-BCN": 88,  "DUS-FCO": 88,  "DUS-MAD": 85,
    "CGN-ATH": 110, "CGN-BCN": 85,  "CGN-FCO": 85,
    "EIN-ATH": 105, "EIN-BCN": 80,  "EIN-MAD": 78,  "EIN-FCO": 90,
    "CRL-ATH": 105, "CRL-BCN": 75,  "CRL-MAD": 72,  "CRL-FCO": 85,
    DEFAULT: 100,
  },
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Convert "2026-06-23T08:45:00+02:00" → "260623" for Skyscanner URLs
function toSkyscannerDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function buildBookingUrl(deal) {
  const orig = deal.origin.toLowerCase();
  const dest = deal.destination.toLowerCase();
  const dep = toSkyscannerDate(deal.departDate);
  const ret = toSkyscannerDate(deal.returnDate);
  if (dep && ret) {
    return `https://www.skyscanner.net/transport/flights/${orig}/${dest}/${dep}/${ret}/`;
  } else if (dep) {
    return `https://www.skyscanner.net/transport/flights/${orig}/${dest}/${dep}/`;
  }
  return `https://www.skyscanner.net/transport/flights/${orig}/${dest}/`;
}

// ─── EMAIL SETUP ─────────────────────────────────────────────────────────────

const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ─── FETCH CHEAP FLIGHTS ─────────────────────────────────────────────────────

async function fetchCheapFlights(origin) {
  const deals = [];

  for (const destination of CONFIG.destinations) {
    const routeKey = `${origin}-${destination}`;
    const baseline = CONFIG.baselines[routeKey] || CONFIG.baselines.DEFAULT;
    const threshold = baseline * (1 - CONFIG.discountThreshold);

    const url = new URL("https://api.travelpayouts.com/v1/prices/cheap");
    url.searchParams.set("token", process.env.TRAVELPAYOUTS_TOKEN);
    url.searchParams.set("origin", origin);
    url.searchParams.set("destination", destination);
    url.searchParams.set("currency", "eur");
    url.searchParams.set("page", "1");

    try {
      const res = await fetch(url.toString());
      const json = await res.json();

      if (!json.success) {
        console.log(`  [${origin}→${destination}] success:false — skipping`);
        continue;
      }

      for (const [dest, data] of Object.entries(json.data || {})) {
        for (const [, flight] of Object.entries(data)) {
          console.log(`  [${origin}→${dest}] €${flight.price} (threshold €${Math.round(threshold)})`);
          if (flight.price <= threshold) {
            deals.push({
              origin,
              destination: dest,
              price: flight.price,
              departDate: flight.departure_at,
              returnDate: flight.return_at,
              airline: flight.airline,
              transfers: flight.transfers,
            });
          }
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

async function validateWithClaude(deal) {
  const routeKey = `${deal.origin}-${deal.destination}`;
  const baseline = CONFIG.baselines[routeKey] || CONFIG.baselines.DEFAULT;

  const prompt = `You are a flight deal expert. Evaluate if this is a genuine deal worth alerting subscribers about.

Route: ${deal.origin} → ${deal.destination}
Price found: €${deal.price} (${deal.transfers === 0 ? "direct" : deal.transfers + " stop(s)"})
Airline: ${deal.airline}
Departure: ${deal.departDate}
Return: ${deal.returnDate || "one-way / not specified"}
Typical price for this route: €${baseline}

Scoring guide:
- Error fare (>70% below normal): score 9-10
- Excellent deal (50-70% below): score 7-8
- Good deal (30-50% below): score 5-6
- Mediocre (<30% below): score 1-4, isDeal: false

Respond ONLY with valid JSON, no markdown:
{"isDeal": true, "score": 8, "label": "Excellent Deal", "reason": "67% below typical price", "urgency": "Book in next 2h"}`;

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
    console.error("Claude validation error:", err.message);
    return { isDeal: false };
  }
}

// ─── SEND TELEGRAM (one message per deal) ────────────────────────────────────

async function sendTelegram(deal, ai) {
  const bookingUrl = buildBookingUrl(deal);
  const emoji = ai.score >= 9 ? "🔥" : ai.score >= 7 ? "⭐" : "✅";
  const depDate = deal.departDate?.slice(0, 10) || "?";
  const retDate = deal.returnDate?.slice(0, 10);

  const message = [
    `✈️ *FLIGHT DEAL*`,
    ``,
    `🛫 *${deal.origin} → ${deal.destination}*`,
    `💶 *€${deal.price}* ${deal.transfers === 0 ? "(direct)" : `(${deal.transfers} stop)`}`,
    `🏷️ ${emoji} ${ai.label} — Score ${ai.score}/10`,
    `📅 ${depDate}${retDate ? " → " + retDate : ""}`,
    `✈️ ${deal.airline}`,
    ``,
    `📝 _${ai.reason}_`,
    `⏰ ${ai.urgency}`,
    ``,
    `👉 [Book on Skyscanner](${bookingUrl})`,
  ].join("\n");

  const telegramRes = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      }),
    }
  );

  const telegramData = await telegramRes.json();
  if (telegramData.ok) {
    console.log(`[TELEGRAM ✓] ${deal.origin}→${deal.destination} €${deal.price}`);
  } else {
    console.error(`[TELEGRAM ✗] Error:`, JSON.stringify(telegramData));
  }
}

// ─── SEND DIGEST EMAIL (all deals in one email) ───────────────────────────────

async function sendDigestEmail(confirmedDeals) {
  const rows = confirmedDeals.map(({ deal, ai }) => {
    const emoji = ai.score >= 9 ? "🔥" : ai.score >= 7 ? "⭐" : "✅";
    const bookingUrl = buildBookingUrl(deal);
    const depDate = deal.departDate?.slice(0, 10) || "?";
    const retDate = deal.returnDate?.slice(0, 10);
    const baseline = CONFIG.baselines[`${deal.origin}-${deal.destination}`] || CONFIG.baselines.DEFAULT;
    const savings = baseline - deal.price;
    const labelColor = ai.score >= 9 ? "#ec4899" : ai.score >= 7 ? "#f97316" : "#00c2a8";

    return `
    <tr>
      <td style="padding:16px 12px;border-bottom:1px solid #1e2030;vertical-align:top">
        <div style="font-size:16px;font-weight:bold;color:#fff">${deal.origin} → ${deal.destination}</div>
        <div style="font-size:12px;color:#8892a4;margin-top:2px">${deal.airline} · ${deal.transfers === 0 ? "Direct" : deal.transfers + " stop"}</div>
      </td>
      <td style="padding:16px 12px;border-bottom:1px solid #1e2030;vertical-align:top">
        <div style="font-size:22px;font-weight:bold;color:#00c2a8">€${deal.price}</div>
        ${savings > 0 ? `<div style="font-size:11px;color:#7c6ff7">save ~€${savings}</div>` : ""}
      </td>
      <td style="padding:16px 12px;border-bottom:1px solid #1e2030;vertical-align:top">
        <div style="font-size:13px;color:#e8e4d9">${depDate}</div>
        ${retDate ? `<div style="font-size:11px;color:#8892a4">↩ ${retDate}</div>` : ""}
      </td>
      <td style="padding:16px 12px;border-bottom:1px solid #1e2030;vertical-align:top">
        <span style="background:${labelColor}20;border:1px solid ${labelColor};color:${labelColor};padding:3px 8px;border-radius:4px;font-size:11px;font-weight:bold">${emoji} ${ai.label}</span>
        <div style="font-size:11px;color:#5a6474;margin-top:4px">${ai.urgency}</div>
      </td>
      <td style="padding:16px 12px;border-bottom:1px solid #1e2030;vertical-align:top">
        <a href="${bookingUrl}" style="background:#00c2a8;color:#000;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:13px;white-space:nowrap">Book →</a>
      </td>
    </tr>`;
  }).join("");

  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0f;font-family:Arial,sans-serif">
<div style="max-width:750px;margin:0 auto;padding:32px 24px">
  <div style="font-size:11px;letter-spacing:0.3em;color:#00c2a8;text-transform:uppercase;margin-bottom:8px">Flight Deal Scanner</div>
  <h1 style="font-size:28px;color:#e8e4d9;margin:0 0 4px">✈️ ${confirmedDeals.length} Deal${confirmedDeals.length > 1 ? "s" : ""} Found</h1>
  <p style="color:#8892a4;font-size:13px;margin:0 0 24px">${new Date().toUTCString()} · ${CONFIG.discountThreshold * 100}%+ below average price</p>
  <div style="background:#0d1117;border:1px solid #1e2030;border-radius:12px;overflow:hidden">
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#0f1420">
          <th style="padding:12px;text-align:left;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Route</th>
          <th style="padding:12px;text-align:left;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Price</th>
          <th style="padding:12px;text-align:left;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Dates</th>
          <th style="padding:12px;text-align:left;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Rating</th>
          <th style="padding:12px;text-align:left;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Book</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div style="color:#4a5568;font-size:11px;text-align:center;margin-top:24px">
    Flight Deal Scanner · Free · Running on GitHub Actions every 2 hours
  </div>
</div></body></html>`;

  await mailer.sendMail({
    from: `"✈️ Flight Deals" <${process.env.GMAIL_USER}>`,
    to: process.env.ALERT_EMAIL,
    subject: `✈️ ${confirmedDeals.length} flight deal${confirmedDeals.length > 1 ? "s" : ""} found — ${new Date().toLocaleDateString()}`,
    html,
  });

  console.log(`[EMAIL DIGEST ✓] Sent ${confirmedDeals.length} deals in one email`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n✈️  Flight Deal Scanner — ${new Date().toISOString()}`);
  console.log(`   Discount threshold: ${CONFIG.discountThreshold * 100}%+ below average`);
  console.log(`   Origins: ${CONFIG.origins.join(", ")}\n`);

  // Debug: confirm secrets are loaded
  console.log(`   TELEGRAM_BOT_TOKEN loaded: ${!!process.env.TELEGRAM_BOT_TOKEN}`);
  console.log(`   TELEGRAM_CHAT_ID loaded: ${!!process.env.TELEGRAM_CHAT_ID}`);
  console.log(`   GMAIL_USER loaded: ${!!process.env.GMAIL_USER}\n`);

  const allDeals = [];

  for (const origin of CONFIG.origins) {
    console.log(`   Checking ${origin}...`);
    const deals = await fetchCheapFlights(origin);
    console.log(`   → ${deals.length} deals below threshold\n`);
    allDeals.push(...deals);
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log(`   Total deals found: ${allDeals.length}`);

  if (allDeals.length === 0) {
    console.log("   No deals this run. Exiting.\n");
    process.exit(0);
  }

  console.log("   Running AI filter...\n");

  let alertsSent = 0;
  const confirmedDeals = [];

  for (const deal of allDeals) {
    const ai = await validateWithClaude(deal);
    const emoji = ai.isDeal ? (ai.score >= 9 ? "🔥" : "⭐") : "✗";
    console.log(`   ${emoji} ${deal.origin}→${deal.destination} €${deal.price} | score:${ai.score} | isDeal:${ai.isDeal}`);

    if (ai.isDeal) {
      await sendTelegram(deal, ai);
      confirmedDeals.push({ deal, ai });
      alertsSent++;
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  // Send one digest email with all confirmed deals
  if (confirmedDeals.length > 0) {
    await sendDigestEmail(confirmedDeals);
  }

  console.log(`\n✅ Done. ${alertsSent} alert(s) sent.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
