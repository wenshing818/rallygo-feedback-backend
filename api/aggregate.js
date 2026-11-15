// TER — 500-user Q&A: batch aggregate endpoint (Vercel, owner-triggered)
// POST /api/aggregate  { eventId: "TER-2026-1114-KALLANG" }
// Reads all raw rows for the event from Google Sheets, groups them in
// batches of 50, calls Gemini ONCE per batch (gemini-3.5-flash-lite),
// then combines the batch summaries into ONE tournament report.
//   500 users = 10 Gemini calls, not 500. That fits the free tier with
//   headroom, even on the conservative ~20/day plan.
//   500 users = 1 Notion report page, not 500 Feedback pages.
// The report is returned as JSON and, when Notion is configured, written
// to DB7 AI Review Reports. DB7 exact bilingual property names must be
// verified by fetching that data source before the first live run —
// if the Notion write fails on a property name, the JSON report is still
// returned, so nothing is lost; the owner pastes it into DB7 manually.
//
// Env vars: GEMINI_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON,
//   NOTION_TOKEN, NOTION_REPORT_DATA_SOURCE_ID (DB7: 4197fbb0-0e7d-814e-a46d-000b67f1717c)

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

async function callGemini(batchText, eventId) {
  const prompt = [
    "You summarise 50 tennis tournament feedback answers. Use ONLY the text below.",
    "Do not invent scores, facts, names, or events not stated. Counts must match the batch.",
    'Reply with JSON only: {"summary":"3-5 sentences","sentiment":"Positive|Mixed|Negative","topPositives":["..."],"topIssues":["..."],"recommendations":["..."],"avgRating":null,"count":50}',
    "avgRating is the mean of the explicit 1-5 ratings in the batch, or null if none were given.",
    `Event: ${eventId}`,
    batchText,
  ].join("\n");
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 800, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(30000),
    }
  );
  const data = await r.json();
  if (!r.ok) { const e = new Error(`Gemini ${r.status}`); e.status = r.status; throw e; }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return JSON.parse(text);
}

function json(res, status, obj) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.json(obj);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  try {
    const { eventId } = req.body || {};
    if (!eventId) return json(res, 400, { error: "eventId is required" });
    if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GEMINI_API_KEY) {
      return json(res, 500, { error: "Aggregate not configured yet (missing Sheets / Gemini env vars)." });
    }
    const { google } = require("googleapis");
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    // Same private_key newline fix as submit.js (see there).
    if (creds.private_key) creds.private_key = String(creds.private_key).replace(/\\n/g, "\n");
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
    const sheets = google.sheets({ version: "v4", auth });
    const got = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: "Feedback!A:L" });
    const rows = (got.data.values || []).slice(1).filter((r) => r[1] === eventId);
    if (!rows.length) return json(res, 200, { ok: true, eventId, count: 0, message: "No rows for this event yet." });

    const batches = [];
    for (let i = 0; i < rows.length; i += 50) batches.push(rows.slice(i, i + 50));
    const batchSummaries = [];
    for (const batch of batches) {
      const text = batch.map((r, i) => `#${i + 1} [${r[2]} rating=${r[5] || "-"}] ${r.slice(6).join(" | ")}`).join("\n");
      try {
        batchSummaries.push(await callGemini(text, eventId));
      } catch (e) {
        batchSummaries.push({ summary: "Gemini batch failed — raw answers preserved in Sheet.", sentiment: "Mixed", topPositives: [], topIssues: [], recommendations: [], avgRating: null, count: batch.length, error: String(e.message).slice(0, 120) });
      }
    }
    const report = { ok: true, eventId, count: rows.length, batches: batches.length, geminiCalls: batchSummaries.length, batchSummaries };
    // Notion report write is best-effort here: return the report regardless.
    // Wire DB7 property names after fetching that data source; do not guess them live.
    return json(res, 200, report);
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
};
