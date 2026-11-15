// RallyGo - 500-user Q&A: batch aggregate endpoint (Vercel, owner-triggered)
// POST /api/aggregate  { eventId: "RALLYGO-2026-1114-KALLANG" }
// Reads all raw rows for the event from Google Sheets, groups them in
// batches of 50, calls Gemini ONCE per batch (gemini-3.5-flash-lite),
// then combines the batch summaries into ONE tournament report.
//   500 users = 10 Gemini calls, not 500. That fits the free tier with
//   headroom, even on the conservative ~20/day plan.
//   500 users = 1 Notion report page, not 500 Feedback pages.
// The report is returned as JSON and, when Notion is configured, written
// to DB7 AI Review Reports. DB7 property names were verified 16 Nov 2026
// by fetching data source 4197fbb0-0e7d-814e-a46d-000b67f1717c.
//
// Env vars: GEMINI_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON,
//   NOTION_TOKEN, NOTION_REPORT_DATA_SOURCE_ID (DB7: 4197fbb0-0e7d-814e-a46d-000b67f1717c)

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

async function callGemini(batchText, eventId, batchSize) {
  const prompt = [
    "You summarise tennis tournament feedback answers. Use ONLY the text below.",
    "Do not invent scores, facts, names, or events not stated. Counts must match the batch.",
    `Reply with JSON only: {"summary":"3-5 sentences","sentiment":"Positive|Mixed|Negative","topPositives":["..."],"topIssues":["..."],"recommendations":["..."],"avgRating":null,"count":${batchSize}}`,
    "avgRating is the mean of the explicit 1-5 ratings in the batch, or null if none were given.",
    `There are exactly ${batchSize} answers in this batch, so count must be ${batchSize}.`,
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

// DB7 property names verified 16 Nov 2026 by fetching data source
// 4197fbb0-0e7d-814e-a46d-000b67f1717c (7. AI Review Reports / AI复盘报告).
const EVENT_PAGE = {
  "RALLYGO-2026-1114-KALLANG": "4197fbb0-0e7d-816b-9c32-f307c1465f99",
  "TER-2026-1114-KALLANG": "4197fbb0-0e7d-816b-9c32-f307c1465f99",
};

async function writeReportToNotion(eventId, { summary, topPositives, topIssues, recommendations, avgRating, count }) {
  const token = process.env.NOTION_TOKEN;
  const dataSourceId = process.env.NOTION_REPORT_DATA_SOURCE_ID;
  if (!token || !dataSourceId) return { skipped: true, reason: "notion-not-configured" };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" }); // SGT date, not UTC
  const props = {
    "Report / 报告": { title: [{ text: { content: `RallyGo x Tennis123 — ${eventId} — AI 复盘报告 (AI-generated, verify before publishing)` } }] },
    "Key Issues / 关键问题": { rich_text: [{ text: { content: (topIssues || []).join("\n").slice(0, 2000) } }] },
    "Positive Findings / 亮点发现": { rich_text: [{ text: { content: (topPositives || []).join("\n").slice(0, 2000) } }] },
    "Feedback Count / 反馈数量": { number: count },
    "Report Version / 报告版本": { rich_text: [{ text: { content: "v1" } }] },
    "Overall Event Score / 赛事总分": avgRating === null ? { number: null } : { number: avgRating },
    "Report Status / 报告状态": { select: { name: "Draft / 草稿" } },
    "Report Date / 报告日期": { date: { start: today } },
    "Recommendations / 改进建议": { rich_text: [{ text: { content: (recommendations || []).join("\n").slice(0, 2000) } }] },
    "Prepared By / 报告人": { rich_text: [{ text: { content: "Wen (AI draft — verify before publishing)" } }] },
    "Next Steps / 下一步行动": { rich_text: [{ text: { content: summary.slice(0, 2000) } }] },
  };
  if (EVENT_PAGE[eventId]) {
    props["Event / 赛事"] = { relation: [{ id: EVENT_PAGE[eventId] }] };
  }
  const resp = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({ parent: { data_source_id: dataSourceId }, properties: props }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, error: body.slice(0, 300) };
  }
  const page = await resp.json();
  return { ok: true, pageId: page.id, url: page.url };
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
      const text = batch.map((r, i) => `#${i + 1} [${r[2]} rating=${r[5] || "-"}] ${r.slice(6, 11).join(" | ")}`).join("\n");
      try {
        batchSummaries.push(await callGemini(text, eventId, batch.length));
      } catch (e) {
        batchSummaries.push({ summary: "Gemini batch failed — raw answers preserved in Sheet.", sentiment: "Mixed", topPositives: [], topIssues: [], recommendations: [], avgRating: null, count: batch.length, error: String(e.message).slice(0, 120) });
      }
    }
    // Combine batches into ONE report. avgRating is computed from the Sheet
    // rows directly (more reliable than asking Gemini to average).
    const ratings = rows.map((r) => Number(r[5])).filter((n) => n >= 1 && n <= 5);
    const avgRating = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;
    const combined = {
      summary: batchSummaries.map((b) => b.summary || "").filter(Boolean).join(" "),
      topPositives: [...new Set(batchSummaries.flatMap((b) => b.topPositives || []))],
      topIssues: [...new Set(batchSummaries.flatMap((b) => b.topIssues || []))],
      recommendations: [...new Set(batchSummaries.flatMap((b) => b.recommendations || []))],
      avgRating,
      count: rows.length,
    };
    const notion = await writeReportToNotion(eventId, combined).catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 200) }));
    const report = { ok: true, eventId, count: rows.length, batches: batches.length, geminiCalls: batchSummaries.length, batchSummaries, combined, notion };
    return json(res, 200, report);
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
};
