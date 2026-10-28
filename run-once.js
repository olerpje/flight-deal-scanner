import fetch from "node-fetch";
import nodemailer from "nodemailer";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabase(method, table, body, params) {
  const url = new URL(SUPABASE_URL + "/rest/v1/" + table);
  url.searchParams.set("select", "*");
  if (params) {
    Object.keys(params).forEach(function(k) { url.searchParams.set(k, params[k]); });
  }
  const options = {
    method: method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : "",
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url.toString(), options);
  if (!res.ok) {
    const err = await res.text();
    throw new Error("Supabase error: " + err);
  }
  if (res.status === 204) return null;
  return res.json();
}

const DEFAULTS = {
  months: [6, 7, 8],
  minDays: 4,
  maxDays: 9,
  discountThreshold: 0.30,
  origins: ["AMS", "EIN", "BRU", "CRL", "FRA", "DUS", "CGN"],
};

const DESTINATIONS = ["ATH", "SKG", "HER", "FCO", "NAP", "PMO", "BCN", "MAD", "AGP", "LIS"];

const BASELINES = {
  "AMS-ATH": 175, "AMS-BCN": 115, "AMS-FCO": 140, "AMS-MAD": 110,
  "AMS-LIS": 160, "AMS-NAP": 150, "AMS-PMO": 175, "AMS-HER": 180,
  "AMS-SKG": 175, "AMS-AGP": 95,
  "EIN-ATH": 125, "EIN-BCN": 130, "EIN-MAD": 125, "EIN-FCO": 95,
  "EIN-SKG": 148, "EIN-HER": 152, "EIN-NAP": 142, "EIN-AGP": 60,
  "EIN-LIS": 95, "EIN-PMO": 150,
  "BRU-ATH": 95, "BRU-BCN": 85,  "BRU-FCO": 90,  "BRU-MAD": 80,
  "BRU-LIS": 80,  "BRU-NAP": 95,  "BRU-HER": 110, "BRU-SKG": 110,
  "BRU-AGP": 88,  "BRU-PMO": 95,
  "CRL-ATH": 105, "CRL-BCN": 75,  "CRL-FCO": 82,  "CRL-MAD": 72,
  "CRL-LIS": 80,  "CRL-NAP": 85,  "CRL-HER": 100, "CRL-SKG": 100,
  "CRL-AGP": 78,  "CRL-PMO": 95,
  "FRA-ATH": 140, "FRA-BCN": 50, "FRA-FCO": 55, "FRA-MAD": 92,
  "FRA-LIS": 115, "FRA-NAP": 115, "FRA-SKG": 165, "FRA-HER": 170,
  "FRA-AGP": 120, "FRA-PMO": 63,
  "DUS-ATH": 132, "DUS-BCN": 80, "DUS-FCO": 108, "DUS-MAD": 95,
  "DUS-LIS": 111, "DUS-NAP": 150, "DUS-SKG": 115, "DUS-HER": 158,
  "DUS-AGP": 65, "DUS-PMO": 115,
  "CGN-ATH": 110, "CGN-BCN": 72, "CGN-FCO": 80, "CGN-MAD": 128,
  "CGN-LIS": 100, "CGN-NAP": 142, "CGN-SKG": 148, "CGN-HER": 150,
    "CGN-AGP": 50, "CGN-PMO": 85,
   DEFAULT: 140,
};

const SCAN_MODE = process.env.SCAN_MODE || "main";
const ERROR_MODE = SCAN_MODE === "errorfares";

const AMS_EXTRA = {
  // Europe
  "AMS-PRG": 90, "AMS-BUD": 100, "AMS-WAW": 90, "AMS-KRK": 90, "AMS-VIE": 100,
  "AMS-CPH": 90, "AMS-ARN": 110, "AMS-OSL": 110, "AMS-DUB": 90, "AMS-EDI": 100,
  "AMS-MXP": 100, "AMS-VCE": 110, "AMS-IST": 190, "AMS-SOF": 110, "AMS-OTP": 120,
  "AMS-ZAG": 130, "AMS-SPU": 160, "AMS-DBV": 170, "AMS-TFS": 200, "AMS-PMI": 130,
  "AMS-OPO": 120, "AMS-FAO": 130, "AMS-NCE": 130, "AMS-KEF": 200, "AMS-MLA": 160,
  // North Africa / Middle East
  "AMS-RAK": 170, "AMS-AGA": 190, "AMS-TLV": 250, "AMS-CAI": 250, "AMS-DXB": 350,
  // Long haul
  "AMS-JFK": 450, "AMS-BOS": 480, "AMS-MIA": 520, "AMS-LAX": 600, "AMS-YYZ": 480,
  "AMS-CUN": 650, "AMS-GRU": 750, "AMS-BKK": 650, "AMS-SIN": 700, "AMS-HKG": 700,
  "AMS-NRT": 800, "AMS-ICN": 750, "AMS-DEL": 550, "AMS-CPT": 650,
};
Object.assign(BASELINES, AMS_EXTRA);

const ERROR_DESTINATIONS = Object.keys(BASELINES)
  .filter(function(k) { return k.startsWith("AMS-"); })
  .map(function(k) { return k.slice(4); });

function getBaseline(origin, destination) {
  const dest = destination === "ROM" ? "FCO" : destination;
  return BASELINES[origin + "-" + dest] || BASELINES.DEFAULT;
}

function loadSettings() {
  try {
    if (fs.existsSync("settings.json")) {
      const s = JSON.parse(fs.readFileSync("settings.json", "utf8"));
      console.log("   Settings loaded from settings.json");
      return Object.assign({}, DEFAULTS, s);
    }
  } catch (e) {}
  console.log("   Using default settings");
  return Object.assign({}, DEFAULTS);
}

function buildBookingUrl(origin, destination, departDate, returnDate) {
  const dep = departDate ? new Date(departDate).toISOString().slice(0, 10) : null;
  const ret = returnDate ? new Date(returnDate).toISOString().slice(0, 10) : null;
  if (dep && ret) return "https://www.google.com/travel/flights?q=Flights+from+" + origin + "+to+" + destination + "+on+" + dep + "+returning+" + ret;
  if (dep) return "https://www.google.com/travel/flights?q=Flights+from+" + origin + "+to+" + destination + "+on+" + dep;
  return "https://www.google.com/travel/flights?q=Flights+from+" + origin + "+to+" + destination;
}

function buildAviasalesUrl(origin, destination, departDate, returnDate) {
  const dm = function(s) { return s.slice(8, 10) + s.slice(5, 7); }; // DDMM
  if (!departDate) return "https://www.aviasales.com/";
  let url = "https://www.aviasales.com/search/" + origin + dm(departDate) + destination;
  if (returnDate) url += dm(returnDate);
  return url + "1"; // 1 passenger
}

function daysBetween(date1, date2) {
  if (!date1 || !date2) return null;
  return Math.round(Math.abs(new Date(date2) - new Date(date1)) / (1000 * 60 * 60 * 24));
}

// ─── LIVE PRICE VERIFICATION ─────────────────────────────────────────────────
// Fetches a fresh price from Travelpayouts for the exact route + date
// If verified price is within €5 of original, deal is confirmed

async function verifyLivePrice(deal) {
  try {
    const depDate = deal.departDate ? new Date(deal.departDate) : null;
    if (!depDate) return { verified: true, livePrice: deal.price };

    const url = new URL("https://api.travelpayouts.com/v1/prices/cheap");
    url.searchParams.set("token", process.env.TRAVELPAYOUTS_TOKEN);
    url.searchParams.set("origin", deal.origin);
    url.searchParams.set("destination", deal.destination);
    url.searchParams.set("currency", "eur");
    url.searchParams.set("depart_date", depDate.toISOString().slice(0, 7)); // YYYY-MM

    const res = await fetch(url.toString());
    const json = await res.json();

    if (!json.success || !json.data) {
      console.log("   [VERIFY] No live data — passing through");
      return { verified: true, livePrice: deal.price };
    }

    // Find the closest matching flight
    let bestPrice = null;
    for (const dest of Object.keys(json.data)) {
      if (dest !== deal.destination) continue;
      for (const key of Object.keys(json.data[dest])) {
        const f = json.data[dest][key];
        if (bestPrice === null || f.price < bestPrice) bestPrice = f.price;
      }
    }

    if (bestPrice === null) {
      console.log("   [VERIFY] Route not found in live check — passing through");
      return { verified: true, livePrice: deal.price };
    }

    const diff = Math.abs(bestPrice - deal.price);
    const verified = diff <= 20;
    console.log("   [VERIFY] " + deal.origin + "→" + deal.destination + " original €" + deal.price + " live €" + bestPrice + " diff €" + diff + " → " + (verified ? "CONFIRMED ✓" : "PRICE CHANGED ✗"));
    return { verified: verified, livePrice: bestPrice };

  } catch (e) {
    console.log("   [VERIFY] Error — passing through:", e.message);
    return { verified: true, livePrice: deal.price };
  }
}

// ─── DEDUPLICATION ────────────────────────────────────────────────────────────

async function isDuplicate(deal) {
  const route = deal.origin + "-" + deal.destination;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const rows = await supabase("GET", "sent_deals", null, {
      route: "eq." + route,
      price: "gte." + (deal.price - 5),
      sent_at: "gte." + since,
      limit: "1",
    });
    return rows && rows.length > 0;
  } catch (e) {
    console.error("Dedup check failed:", e.message);
    return false;
  }
}

async function markAsSent(deal) {
  const route = deal.origin + "-" + deal.destination;
  try {
    await supabase("POST", "sent_deals", {
      route: route,
      price: deal.price,
      depart_date: deal.departDate ? deal.departDate.slice(0, 10) : null,
      return_date: deal.returnDate ? deal.returnDate.slice(0, 10) : null,
      airline: deal.airline,
    }, null);
  } catch (e) {
    console.error("Mark as sent failed:", e.message);
  }
}

async function getSubscribers() {
  try {
    const rows = await supabase("GET", "subscribers", null, { active: "eq.true" });
    return rows || [];
  } catch (e) {
    console.error("Failed to fetch subscribers:", e.message);
    return [];
  }
}

const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

async function fetchCheapFlights(origin, settings, destinations) {
  const deals = [];
  for (const destination of destinations) {
    const routeKey = origin + "-" + destination;
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
            if (!json.success) { console.log("  [" + origin + "→" + destination + "] API returned no data"); continue; }

      for (const dest of Object.keys(json.data || {})) {
        const data = json.data[dest];
        for (const key of Object.keys(data)) {
          const flight = data[key];
          const depMonth = new Date(flight.departure_at).getMonth() + 1;
          if (!settings.months.includes(depMonth)) continue;
          const tripDays = daysBetween(flight.departure_at, flight.return_at);
          if (tripDays !== null && (tripDays < settings.minDays || tripDays > settings.maxDays)) continue;
          if (flight.price > threshold) continue;
          console.log("  [" + origin + "→" + dest + "] €" + flight.price + " | " + (flight.departure_at ? flight.departure_at.slice(0,10) : "?") + " → " + (flight.return_at ? flight.return_at.slice(0,10) : "?") + " (" + tripDays + "d)");
          deals.push({
            origin: origin, destination: dest, price: flight.price,
            departDate: flight.departure_at, returnDate: flight.return_at,
            airline: flight.airline, transfers: flight.transfers, tripDays: tripDays,
          });
        }
      }
    } catch (err) {
      console.error("  [" + origin + "→" + destination + "] Error:", err.message);
    }
    await new Promise(function(r) { setTimeout(r, 300); });
  }
  return deals;
}

async function validateWithClaude(deal) {
  const baseline = getBaseline(deal.origin, deal.destination);
  const discount = Math.round((1 - deal.price / baseline) * 100);
  const prompt = "You are a flight deal expert. Evaluate this deal.\n" +
    "Route: " + deal.origin + " to " + deal.destination + "\n" +
    "Price: EUR " + deal.price + " (" + (deal.transfers === 0 ? "direct" : deal.transfers + " stop(s)") + ")\n" +
    "Airline: " + deal.airline + "\n" +
    "Departure: " + (deal.departDate ? deal.departDate.slice(0,10) : "unknown") + "\n" +
    "Return: " + (deal.returnDate ? deal.returnDate.slice(0,10) : "not specified") + "\n" +
    "Trip: " + (deal.tripDays !== null ? deal.tripDays + " days" : "unknown") + "\n" +
    "Typical price: EUR " + baseline + "\n" +
    "Discount: " + discount + "%\n" +
    "Score 9-10 error fare (>70% off), 7-8 excellent (50-70% off), 5-6 good (30-50% off), 1-4 mediocre.\n" +
    'Respond ONLY with valid JSON: {"isDeal": true, "score": 8, "label": "Excellent Deal", "reason": "one sentence", "urgency": "Book in next 2h"}';
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
    const text = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (err) {
    return { isDeal: false };
  }
}
async function sendTelegramToSubscriber(deal, ai, chatId) {
  const url = buildAviasalesUrl(deal.origin, deal.destination, deal.departDate, deal.returnDate);
  const gUrl = buildBookingUrl(deal.origin, deal.destination, deal.departDate, deal.returnDate);
  const NL = String.fromCharCode(10);
  const emoji = ai.score >= 9 ? "🔥" : ai.score >= 7 ? "⭐" : "✅";
  const dep = deal.departDate ? deal.departDate.slice(0,10) : "?";
  const ret = deal.returnDate ? deal.returnDate.slice(0,10) : null;
  const msg = "✈️ *FLIGHT DEAL*" + NL + NL +
    "🛫 *" + deal.origin + " → " + deal.destination + "*" + NL +
    "💶 *€" + deal.price + "*" + (stopsLabel(deal.transfers) ? " (" + stopsLabel(deal.transfers) + ")" : "") + NL +
    "📅 " + dep + (ret ? " → " + ret : "") + (deal.tripDays ? " (" + deal.tripDays + "d)" : "") + NL +
    "✈️ " + deal.airline + NL +
    "🏷️ " + emoji + " " + ai.label + " — Score " + ai.score + "/10" + NL + NL +
    "📝 _" + ai.reason + "_" + NL +
    "⏰ " + ai.urgency + NL + NL +
    "👉 [Check price on Aviasales](" + url + ")" + NL +
    "🔎 [Compare on Google Flights](" + gUrl + ")" + NL +
    "_Cached fare, price may have changed_";
  const r = await fetch("https://api.telegram.org/bot" + process.env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "Markdown" }),
  });
  const d = await r.json();
  if (!d.ok) console.error("[TELEGRAM ✗] chat_id " + chatId + ":", d.description);
  else console.log("[TELEGRAM ✓] chat_id " + chatId);
}
// ─── MOBILE-FRIENDLY EMAIL ────────────────────────────────────────────────────

// ─── EMAIL TEMPLATE (table-based, works in Gmail/Outlook/Apple Mail) ─────────
// Replace the whole old buildEmailHtml() in run-once.js with everything below.

const AIRLINES = {
  FR: "Ryanair", U2: "easyJet", W6: "Wizz Air", KL: "KLM", HV: "Transavia",
  TO: "Transavia France", LH: "Lufthansa", EW: "Eurowings", VY: "Vueling",
  IB: "Iberia", TP: "TAP Portugal", A3: "Aegean", SN: "Brussels Airlines",
  AF: "Air France", BA: "British Airways", DY: "Norwegian", LX: "Swiss",
  OS: "Austrian", SK: "SAS", AZ: "ITA Airways", PC: "Pegasus", TK: "Turkish Airlines",
};

function airlineName(code) {
  if (!code) return "";
  return AIRLINES[code] || code;
}

// Travelpayouts often returns no "transfers" field -> return null so we hide it
function stopsLabel(t) {
  if (t === 0) return "Direct";
  if (t === 1) return "1 stop";
  if (typeof t === "number" && t > 1) return t + " stops";
  return null;
}

// "2026-11-27T..." -> "Fri 27 Nov"
function fmtDate(iso) {
  if (!iso) return "?";
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
}

// "Sun 25 Oct, 16:55" in Amsterdam time
function fmtNow() {
  const d = new Date();
  const date = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Amsterdam" }).replace(",", "");
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
  return date + ", " + time;
}

function infoCell(label, value, isLast) {
  return "<td valign='top' style='padding-right:" + (isLast ? "0" : "28px") + ";white-space:nowrap'>" +
    "<div style='font-size:10px;color:#6b7686;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px'>" + label + "</div>" +
    "<div style='font-size:15px;color:#e8e4d9;font-weight:600'>" + value + "</div>" +
    "</td>";
}

function buildEmailHtml(confirmedDeals, tier) {
  const FONT = "-apple-system,'Segoe UI',Roboto,Arial,sans-serif";

  const cards = confirmedDeals.map(function(item) {
    const deal = item.deal;
    const ai = item.ai;
    const emoji = ai.score >= 9 ? "🔥" : ai.score >= 7 ? "⭐" : "✅";
    const url = buildAviasalesUrl(deal.origin, deal.destination, deal.departDate, deal.returnDate);
    const gUrl = buildBookingUrl(deal.origin, deal.destination, deal.departDate, deal.returnDate);
    const baseline = getBaseline(deal.origin, deal.destination);
    const savings = Math.round(baseline - deal.price);
    const labelColor = ai.score >= 9 ? "#ec4899" : ai.score >= 7 ? "#f97316" : "#00c2a8";
    const borderColor = ai.score >= 9 ? "#ec489940" : ai.score >= 7 ? "#f9731640" : "#00c2a840";

    const subParts = [airlineName(deal.airline), stopsLabel(deal.transfers)].filter(Boolean);
    const subLine = subParts.join(" · ");

    const infoCells = [infoCell("Departure", fmtDate(deal.departDate), !deal.returnDate && !deal.tripDays)];
    if (deal.returnDate) infoCells.push(infoCell("Return", fmtDate(deal.returnDate), !deal.tripDays));
    if (deal.tripDays) infoCells.push(infoCell("Duration", deal.tripDays + (deal.tripDays === 1 ? " day" : " days"), true));

    return "<table role='presentation' width='100%' cellpadding='0' cellspacing='0' border='0' style='background:#0d1117;border:1px solid " + borderColor + ";border-radius:12px;border-collapse:separate;margin-bottom:16px'>" +

      // Route (left) + price (right)
      "<tr><td style='padding:18px 18px 14px'>" +
        "<table role='presentation' width='100%' cellpadding='0' cellspacing='0' border='0'><tr>" +
          "<td valign='top' style='font-family:" + FONT + "'>" +
            "<div style='font-size:20px;font-weight:700;color:#ffffff;white-space:nowrap'>" + deal.origin + " → " + deal.destination + "</div>" +
            (subLine ? "<div style='font-size:12px;color:#8892a4;margin-top:4px'>" + subLine + "</div>" : "") +
          "</td>" +
          "<td valign='top' align='right' style='font-family:" + FONT + ";padding-left:12px'>" +
            "<div style='font-size:28px;font-weight:700;color:#00c2a8;white-space:nowrap;line-height:1'>€" + Math.round(deal.price) + "</div>" +
            (savings > 0 ? "<div style='font-size:11px;color:#6b7686;margin-top:6px;white-space:nowrap'>save ~€" + savings + "</div>" : "") +
          "</td>" +
        "</tr></table>" +
      "</td></tr>" +

      // Dates
      "<tr><td style='padding:0 18px 16px;font-family:" + FONT + "'>" +
        "<table role='presentation' cellpadding='0' cellspacing='0' border='0'><tr>" + infoCells.join("") + "</tr></table>" +
      "</td></tr>" +

      // Badge + urgency
      "<tr><td style='padding:0 18px 14px;font-family:" + FONT + "'>" +
        "<span style='display:inline-block;background:" + labelColor + "20;border:1px solid " + labelColor + ";color:" + labelColor + ";padding:4px 10px;border-radius:6px;font-size:12px;font-weight:700'>" + emoji + " " + ai.label + "</span>" +
        (ai.urgency ? "<div style='font-size:12px;color:#8892a4;margin-top:8px'>⏰ " + ai.urgency + "</div>" : "") +
      "</td></tr>" +

      // Reason
      "<tr><td style='padding:0 18px 18px;font-family:" + FONT + ";font-size:13px;line-height:1.5;color:#8892a4;font-style:italic'>" + ai.reason + "</td></tr>" +

      // Buttons
      "<tr><td style='padding:0 18px 10px'>" +
        "<a href='" + url + "' style='display:block;background:#00c2a8;color:#000000;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-family:" + FONT + ";font-weight:700;font-size:16px'>Check price on Aviasales →</a>" +
      "</td></tr>" +
      "<tr><td style='padding:0 18px 18px'>" +
        "<a href='" + gUrl + "' style='display:block;border:1px solid #00c2a8;color:#00c2a8;text-align:center;padding:12px;border-radius:8px;text-decoration:none;font-family:" + FONT + ";font-size:14px'>Compare on Google Flights</a>" +
      "</td></tr>" +

      // Cached-fare warning
      "<tr><td style='padding:0 18px 16px;font-family:" + FONT + ";font-size:11px;color:#6b7686;text-align:center'>Cached fare, price may have changed</td></tr>" +
    "</table>";
  }).join("");

  const freeNote = tier === "free"
    ? "<div style='background:#f9731610;border:1px solid #f9731640;border-radius:10px;padding:14px 16px;margin-bottom:20px;font-family:" + FONT + ";font-size:13px;color:#f97316'>⏰ <strong>Free tier — 24h delayed.</strong> <a href='https://olerpje.github.io/flight-deal-scanner/signup.html' style='color:#f97316;font-weight:bold'>Upgrade to Premium (€9/mo)</a> for instant alerts + Telegram.</div>"
    : "";

  const n = confirmedDeals.length;

  return "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><meta name='color-scheme' content='dark'></head>" +
    "<body style='margin:0;padding:0;background:#0a0a0f;font-family:" + FONT + "'>" +
    "<table role='presentation' width='100%' cellpadding='0' cellspacing='0' border='0' style='background:#0a0a0f'><tr><td align='center' style='padding:24px 16px'>" +
      "<table role='presentation' width='100%' cellpadding='0' cellspacing='0' border='0' style='max-width:560px'><tr><td>" +
        "<div style='font-family:" + FONT + ";font-size:10px;letter-spacing:0.3em;color:#00c2a8;text-transform:uppercase;margin-bottom:8px'>Flight Deal Scanner</div>" +
        "<h1 style='font-family:" + FONT + ";font-size:24px;color:#e8e4d9;margin:0 0 4px'>✈️ " + n + " Deal" + (n > 1 ? "s" : "") + " Found</h1>" +
        "<p style='font-family:" + FONT + ";color:#8892a4;font-size:12px;margin:0 0 20px'>" + fmtNow() + "</p>" +
        freeNote +
        cards +
        "<div style='font-family:" + FONT + ";color:#6b7686;font-size:11px;text-align:center;margin-top:8px'>" +
          "Flight Deal Scanner · <a href='https://olerpje.github.io/flight-deal-scanner/signup.html' style='color:#00c2a8'>Manage subscription</a>" +
        "</div>" +
      "</td></tr></table>" +
    "</td></tr></table>" +
    "</body></html>";
}

async function sendEmailToSubscriber(email, deals, tier) {
  try {
    const html = buildEmailHtml(deals, tier);
    await mailer.sendMail({
      from: '"Flight Deals" <' + process.env.GMAIL_USER + ">",
      to: email,
      subject: "✈️ " + deals.length + " flight deal" + (deals.length > 1 ? "s" : "") + " found" + (tier === "free" ? " (free tier)" : ""),
      html: html,
    });
    console.log("[EMAIL ✓] " + tier + " → " + email + " (" + deals.length + " deals)");
  } catch (e) {
    console.error("[EMAIL ✗] " + email + ": " + e.message);
  }
}

async function main() {
const settings = loadSettings();
if (ERROR_MODE) {
  Object.assign(settings, {
    origins: ["AMS"],
    months: [1,2,3,4,5,6,7,8,9,10,11,12],
    minDays: 3,
    maxDays: 30,
    discountThreshold: 0.45,
  });
}
const destinations = ERROR_MODE ? ERROR_DESTINATIONS : DESTINATIONS;
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  console.log("\n✈️  Flight Deal Scanner — " + new Date().toISOString());
  console.log("   Months: " + settings.months.map(function(m) { return monthNames[m-1]; }).join(", "));
  console.log("   Trip: " + settings.minDays + "–" + settings.maxDays + " days | Discount: " + Math.round(settings.discountThreshold*100) + "%+");
  console.log("   Origins: " + settings.origins.join(", ") + "\n");

  const allDeals = [];
  for (const origin of settings.origins) {
    console.log("   Checking " + origin + "...");
    const deals = await fetchCheapFlights(origin, settings, destinations);
    console.log("   → " + deals.length + " potential deals\n");
    allDeals.push(...deals);
    await new Promise(function(r) { setTimeout(r, 600); });
  }

  console.log("   Total matching: " + allDeals.length);
  if (allDeals.length === 0) { console.log("   No deals. Exiting.\n"); process.exit(0); }

  console.log("   Running AI filter + price verification + deduplication...\n");
  const newDeals = [];

  for (const deal of allDeals) {
    // Step 1 — AI filter
    const ai = await validateWithClaude(deal);
    if (!ai.isDeal || (ERROR_MODE && ai.score < 7)) {
      console.log("   ✗ " + deal.origin + "→" + deal.destination + " €" + deal.price + " | score:" + ai.score);
      continue;
    }

    // Step 2 — Live price verification
    const verify = await verifyLivePrice(deal);
    if (!verify.verified) {
      console.log("   ✗ PRICE CHANGED: " + deal.origin + "→" + deal.destination + " was €" + deal.price + " now €" + verify.livePrice + " — skipping");
      continue;
    }

    // Update price to verified live price
    deal.price = verify.livePrice;

    // Step 3 — Deduplication
    const duplicate = await isDuplicate(deal);
    if (duplicate) {
      console.log("   ⟳ " + deal.origin + "→" + deal.destination + " €" + deal.price + " — already sent, skipping");
      continue;
    }

    const emoji = ai.score >= 9 ? "🔥" : "⭐";
    console.log("   " + emoji + " NEW VERIFIED: " + deal.origin + "→" + deal.destination + " €" + deal.price + " | score:" + ai.score);
    newDeals.push({ deal: deal, ai: ai });
    await markAsSent(deal);
    await new Promise(function(r) { setTimeout(r, 400); });
  }

  if (newDeals.length === 0) {
    console.log("\n   No new verified deals. Exiting.\n");
    process.exit(0);
  }

  console.log("\n   " + newDeals.length + " new verified deals to send!\n");

   // Send to owner
  try {
    await sendEmailToSubscriber(process.env.ALERT_EMAIL, newDeals, "premium");
  } catch (e) {
    console.error("[EMAIL ✗]", e.message);
  }
  if (process.env.TELEGRAM_CHAT_ID) {
        for (const item of newDeals) {
      try {
        await sendTelegramToSubscriber(item.deal, item.ai, process.env.TELEGRAM_CHAT_ID);
      } catch (e) {
        console.error("[TELEGRAM ✗]", e.message);
      }
      await new Promise(function(r) { setTimeout(r, 1200); });
    }
  }

  // Send to subscribers
  const subscribers = await getSubscribers();
  console.log("\n   Subscribers: " + subscribers.length);

  for (const sub of subscribers) {
    const relevantDeals = (sub.origins && sub.origins.length > 0)
      ? newDeals.filter(function(item) {
          return sub.origins.includes(item.deal.origin) &&
            (!sub.destinations || sub.destinations.length === 0 || sub.destinations.includes(item.deal.destination));
        })
      : newDeals;

    if (relevantDeals.length === 0) continue;

    if (sub.tier === "premium") {
      if (sub.alert_method === "email" || sub.alert_method === "both") {
        await sendEmailToSubscriber(sub.email, relevantDeals, "premium");
      }
      if ((sub.alert_method === "telegram" || sub.alert_method === "both") && sub.telegram_chat_id) {
        for (const item of relevantDeals) {
          await sendTelegramToSubscriber(item.deal, item.ai, sub.telegram_chat_id);
        }
      }
    } else {
      await sendEmailToSubscriber(sub.email, relevantDeals, "free");
    }
  }

  console.log("\n✅ Done. " + newDeals.length + " verified deal(s) sent to " + subscribers.length + " subscriber(s).\n");
  process.exit(0);
}

main().catch(function(err) {
  console.error("Fatal error:", err);
  process.exit(1);
});
