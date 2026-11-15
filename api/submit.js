// TER — 500-user Q&A: fast submit endpoint (Vercel)
// POST /api/submit
// Design change 15 Nov 2026: 500 users fill this in after EACH tournament.
// Do NOT call Gemini per submission and do NOT create 500 Notion pages.
//   500 Gemini calls = 25x the ~20/day free plan, and exactly at the
//   third-party 500/day Flash-Lite reading — no headroom for retries.
//   500 Notion pages = ~3,500 blocks (page + 6 body blocks each).
// Instead: this endpoint stores the raw Q&A in ONE Google Sheet row
// (free, 500 rows is trivial), returns {ok:true} in <1s, and Gemini
// runs ONCE per batch of 50 in /api/aggregate — 10 calls per tournament.
//
// Env vars (Vercel Dashboard, never in code / never in chat):
//   GOOGLE_SHEET_ID               — Sheet with header row: timestamp,eventId,role,crewFunction,language,q1,q2,q3,q4,q5,rating
//   GOOGLE_SERVICE_ACCOUNT_JSON   — service-account JSON (one line), Sheet shared with its email as Editor
//   NOTION_FEEDBACK_DATA_SOURCE_ID — kept for aggregate report fallback, not used here
//
// If Sheets is not configured yet, the endpoint does NOT lose the answer:
// it returns {ok:false, queued:false, record} so the page shows Copy/Download
// and the owner can import it. Never silently drop a submission.

function json(res, status, obj) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.json(obj);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  try {
    const b = req.body || {};
    if (!b.eventId || !b.role || !Array.isArray(b.answers) || b.answers.length === 0) {
      return json(res, 400, { error: "eventId, role and answers[] are required" });
    }
    if (!["Player", "Event Crew", "Organizer"].includes(b.role)) {
      return json(res, 400, { error: "role must be Player, Event Crew or Organizer" });
    }
    // Rating: only if the user tapped / typed an explicit 1-5. Never invented.
    const rating = typeof b.rating === "number" && b.rating >= 1 && b.rating <= 5 ? b.rating : null;
    const row = [
      new Date().toISOString(),
      b.eventId,
      b.role,
      b.crewFunction || "",
      b.language || "en",
      rating === null ? "" : rating,
      ...[0, 1, 2, 3, 4].map((i) => (b.answers[i] && b.answers[i].answer) || ""),
    ];

    if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      return json(res, 200, {
        ok: false,
        stored: "not-configured",
        message: "Sheets not configured yet — keep the Copy/Download record, nothing is lost.",
        record: { eventId: b.eventId, role: b.role, rating, answers: b.answers, submittedAt: row[0] },
      });
    }

    const { google } = require("googleapis");
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    // Fix for Vercel env-var pasting: the private_key's \n escapes often
    // arrive double-escaped (literal backslash-n), which OpenSSL rejects
    // with "DECODER routines::unsupported". Normalise to real newlines.
    if (creds.private_key) creds.private_key = String(creds.private_key).replace(/\\n/g, "\n");
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Feedback!A:L",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
    return json(res, 200, { ok: true, stored: "sheet", eventId: b.eventId, role: b.role });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
};
