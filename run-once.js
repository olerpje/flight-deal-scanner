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
discountThreshold: 0.30, // alert if 30% below average
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
        console.log(`  [${origin}→${destination}] success:false`);
        continue;
      }

      for (const [dest, data] of Object.entries(json.data || {})) {
        for (const [, flight] of Object.entries(data)) {
          console.log(`  [${origin}→${dest}] €${flight.price}`);
const routeKey = `${origin}-${dest}`;
const baseline = CONFIG.baselines[routeKey] || CONFIG.baselines.DEFAULT;
if (flight.price <= baseline * (1 - CONFIG.discountThreshold)) {
            deals.push({
              origin, destination: dest, price: flight.price,
              departDate: flight.departure_at, returnDate: flight.return_at,
              airline: flight.airline, transfers: flight.transfers,
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

// ─── SEND TELEGRAM ────────────────────────────────────────────────────────────

async function sendTelegram(deal, ai) {
  const bookingUrl = `https://www.skyscanner.net/transport/flights/${deal.origin.toLowerCase()}/${deal.destination.toLowerCase()}/`;
  const emoji = ai.score >= 9 ? "🔥" : ai.score >= 7 ? "⭐" : "✅";

  const message = `✈️ *FLIGHT DEAL ALERT*

🛫 *${deal.origin} → ${deal.destination}*
💶 *€${deal.price}* ${deal.transfers === 0 ? "(direct)" : `(${deal.transfers} stop)`}
🏷️ ${emoji} ${ai.label} — Score ${ai.score}/10
📅 ${deal.departDate?.slice(0, 10)}${deal.returnDate ? " → " + deal.returnDate.slice(0, 10) : ""}
✈️ ${deal.airline}

📝 _${ai.reason}_
⏰ ${ai.urgency}

👉 [Book on Skyscanner](${bookingUrl})`;

  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown",
    }),
  });

  console.log(`[TELEGRAM ✓] ${deal.origin}→${deal.destination} €${deal.price}`);
}

// ─── SEND EMAIL ───────────────────────────────────────────────────────────────

async function sendEmail(deal, ai) {
  const bookingUrl = `https://www.skyscanner.net/transport/flights/${deal.origin.toLowerCase()}/${deal.destination.toLowerCase()}/`;
  const labelColor = ai.score >= 9 ? "#ec4899" : ai.score >= 7 ? "#f97316" : "#00c2a8";
  const baseline = CONFIG.baselines[`${deal.origin}-${deal.destination}`] || CONFIG.baselines.DEFAULT;
  const savings = baseline - deal.price;

  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0f;font-family:Georgia,serif">
<div style="max-width:600px;margin:0 auto;padding:32px 24px">
  <div style="font-size:11px;letter-spacing:0.3em;color:#00c2a8;text-transform:uppercase;margin-bottom:8px">Flight Deal Scanner</div>
  <h1 style="font-size:32px;color:#e8e4d9;margin:0 0 24px">✈️ Deal Alert</h1>
  <div style="background:#0d1117;border:1px solid #1e2030;border-radius:12px;padding:24px;margin-bottom:20px">
    <div style="font-size:26px;font-weight:bold;color:#fff;margin-bottom:4px">${deal.origin} → ${deal.destination}</div>
    <div style="font-size:44px;font-weight:bold;color:#00c2a8;margin-bottom:8px">€${deal.price}</div>
    <div style="color:#8892a4;font-size:14px">${deal.transfers === 0 ? "Direct" : deal.transfers + " stop(s)"} · ${deal.airline} · ${deal.departDate?.slice(0, 10)}</div>
    ${savings > 0 ? `<div style="margin-top:8px;color:#7c6ff7;font-size:13px">~€${savings} below typical price</div>` : ""}
  </div>
  <div style="background:${labelColor}20;border:1px solid ${labelColor};border-radius:8px;padding:14px 18px;margin-bottom:20px">
    <div style="color:${labelColor};font-weight:bold;font-size:16px;margin-bottom:4px">${ai.label}</div>
    <div style="color:#c0c8d8;font-size:14px">${ai.reason}</div>
    <div style="color:${labelColor};font-size:13px;margin-top:8px;font-weight:bold">⏰ ${ai.urgency}</div>
  </div>
  <a href="${bookingUrl}" style="display:block;background:#00c2a8;color:#000;text-align:center;padding:16px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:18px;margin-bottom:24px">Book Now on Skyscanner →</a>
  <div style="color:#4a5568;font-size:11px;text-align:center">Flight Deal Scanner · Free · Running on GitHub Actions</div>
</div></body></html>`;

  await mailer.sendMail({
    from: `"✈️ Flight Deals" <${process.env.GMAIL_USER}>`,
    to: process.env.ALERT_EMAIL,
    subject: `✈️ ${ai.label}: ${deal.origin}→${deal.destination} €${deal.price} — ${ai.urgency}`,
    html,
  });

  console.log(`[EMAIL ✓] ${deal.origin}→${deal.destination} €${deal.price}`);
}

async function sendDigestEmail(confirmedDeals) {
  const rows = confirmedDeals.map(({ deal, ai }) => {
    const emoji = ai.score >= 9 ? "🔥" : "⭐";
    return `
      <tr>
        <td style="padding:12px;border-bottom:1px solid #1e2030;color:#fff;font-weight:bold">${deal.origin} → ${deal.destination}</td>
        <td style="padding:12px;border-bottom:1px solid #1e2030;color:#00c2a8;font-weight:bold;font-size:18px">€${deal.price}</td>
        <td style="padding:12px;border-bottom:1px solid #1e2030;color:#e8e4d9">${emoji} ${ai.label}</td>
        <td style="padding:12px;border-bottom:1px solid #1e2030;color:#8892a4;font-size:12px">${deal.departDate?.slice(0,10)}</td>
        <td style="padding:12px;border-bottom:1px solid #1e2030">
          <a href="https://www.skyscanner.net/transport/flights/${deal.origin.toLowerCase()}/${deal.destination.toLowerCase()}/" 
             style="background:#00c2a8;color:#000;padding:6px 12px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:12px">Book →</a>
        </td>
      </tr>`;
  }).join("");

  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0f;font-family:Georgia,serif">
<div style="max-width:700px;margin:0 auto;padding:32px 24px">
  <div style="font-size:11px;letter-spacing:0.3em;color:#00c2a8;text-transform:uppercase;margin-bottom:8px">Flight Deal Scanner</div>
  <h1 style="font-size:28px;color:#e8e4d9;margin:0 0 4px">✈️ ${confirmedDeals.length} Deal${confirmedDeals.length > 1 ? "s" : ""} Found</h1>
  <p style="color:#8892a4;font-size:13px;margin:0 0 24px">${new Date().toUTCString()}</p>
  <table style="width:100%;border-collapse:collapse;background:#0d1117;border:1px solid #1e2030;border-radius:12px;overflow:hidden">
    <thead>
      <tr style="background:#0f1420">
        <th style="padding:12px;text-align:left;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Route</th>
        <th style="padding:12px;text-align:left;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Price</th>
        <th style="padding:12px;text-align:left;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Rating</th>
        <th style="padding:12px;text-align:left;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Date</th>
        <th style="padding:12px;text-align:left;color:#4a5568;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Book</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div style="color:#4a5568;font-size:11px;text-align:center;margin-top:24px">Flight Deal Scanner · GitHub Actions · Every 2 hours</div>
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
console.log(`   Threshold: ${CONFIG.discountThreshold * 100}% below average`);
  console.log(`   Origins: ${CONFIG.origins.join(", ")}\n`);

  const allDeals = [];

  for (const origin of CONFIG.origins) {
    process.stdout.write(`   Checking ${origin}... `);
    const deals = await fetchCheapFlights(origin);
    console.log(`${deals.length} deals found`);
    allDeals.push(...deals);
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log(`\n   Total below €${CONFIG.priceThresholdEur}: ${allDeals.length}`);

  if (allDeals.length === 0) {
    console.log("   No deals found this run. Exiting.\n");
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
