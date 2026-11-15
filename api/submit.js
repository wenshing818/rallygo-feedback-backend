// RallyGo - 500-user Q&A: fast submit endpoint (Vercel)
// POST /api/submit
// Design: 500 users fill this in after EACH tournament.
// Fast submit stores the raw Q&A in ONE Google Sheet row (free),
// AND creates ONE row in the Notion Feedback database (DB4) so the
// owner sees each reply in Notion automatically — no copy/paste.
// Gemini runs ONCE per batch of 50 in /api/aggregate — 10 calls
// per tournament — producing 1 report for Notion DB7.
//
// Env vars (Vercel Dashboard, never in code / never in chat):
//   GOOGLE_SHEET_ID               — Sheet with header row: timestamp,eventId,role,crewFunction,language,q1,q2,q3,q4,q5,rating
//   GOOGLE_SERVICE_ACCOUNT_JSON   — service-account JSON (one line), Sheet shared with its email as Editor
//   NOTION_TOKEN                  — internal integration 'RallyGo Feedback Backend'
//   NOTION_FEEDBACK_DATA_SOURCE_ID — Feedback DB4 data source id
//
// Payloads accepted (both, so old and new pages work):
//   A) { eventId, role, crewFunction, language, rating, submittedBy,
//        answers: [{answer}, ...] }  — 5 text answers, rating separate
//   B) { record: { event_id, role, crew_function, submitted_by, language,
//        overall_rating, original_responses: [{q, a}, ...] } }
//      — original_responses[0] is the rating question, the rest are text.
//   C) the record object itself, without the {record:} wrapper.
//
// If Sheets is not configured yet, the endpoint does NOT lose the answer:
// it returns {ok:false, queued:false, record} so the page shows Copy/Download
// and the owner can import it. Never silently drop a submission.
// Notion write is best-effort: if it fails, the Sheet save still counts
// as ok:true and the error is returned in the response as notionError.

function json(res, status, obj) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.json(obj);
}

const ROLE_NOTION = {
  Player: "Player / 球员",
  "Event Crew": "Event Crew / 赛事工作人员",
  Organizer: "Organizer / 组织者",
};
const CREW_NOTION = {
  Umpire: "Umpire / 裁判",
  Volunteer: "Volunteer / 志愿者",
  Both: "Both / 两者",
  Other: "Other / 其他",
};
// Known event page ids in the RallyGo Events database, for the Event relation.
// Old TER-... id kept as an alias so earlier submissions still link.
const EVENT_PAGE = {
  "RALLYGO-2026-1114-KALLANG": "4197fbb0-0e7d-816b-9c32-f307c1465f99",
  "TER-2026-1114-KALLANG": "4197fbb0-0e7d-816b-9c32-f307c1465f99", // alias — old event id
};

function normalise(body) {
  const b = body || {};
  const r = b.record && typeof b.record === "object" ? b.record : b;
  const eventId = r.eventId || r.event_id || "";
  const role = r.role || "";
  const language = r.language || "en";
  const crewFunction = r.crewFunction || r.crew_function || "";
  const submittedBy = r.submittedBy || r.submitted_by || r.submitted_by_name || "";
  let rating = null;
  if (typeof r.rating === "number") rating = r.rating;
  else if (typeof r.overall_rating === "number") rating = r.overall_rating;
  else if (typeof r.overallRating === "number") rating = r.overallRating;
  let answers = [];
  if (Array.isArray(r.answers) && r.answers.length) {
    answers = r.answers.map((a) => (typeof a === "string" ? a : a && a.answer ? a.answer : "")).filter((x) => x !== undefined);
  } else if (Array.isArray(r.original_responses) && r.original_responses.length) {
    // First entry is the rating question ("4 / 5 – 好"); the rest are text.
    const rest = r.original_responses.slice(1);
    answers = rest.map((o) => (o && o.a ? o.a : ""));
    if (rating === null && r.original_responses[0] && r.original_responses[0].a) {
      const m = String(r.original_responses[0].a).match(/([1-5])\s*\/\s*5/);
      if (m) rating = Number(m[1]);
    }
  }
  if (rating !== null && (rating < 1 || rating > 5)) rating = null;
  return { eventId, role, language, crewFunction, submittedBy, rating, answers };
}

async function writeToNotion(n, timestamp) {
  const token = process.env.NOTION_TOKEN;
  const dataSourceId = process.env.NOTION_FEEDBACK_DATA_SOURCE_ID;
  if (!token || !dataSourceId) return { skipped: true, reason: "notion-not-configured" };
  const props = {
    "Feedback / 反馈": { title: [{ text: { content: `${n.role} — ${n.eventId} — ${n.submittedBy || "Anonymous"} — ${timestamp.slice(0, 10)}` } }] },
    "Role / 角色": { select: { name: ROLE_NOTION[n.role] || "Player / 球员" } },
    "Overall Rating (1-5) / 整体评分": n.rating === null ? { number: null } : { number: n.rating },
    "What Went Well / 做得好的地方": { rich_text: [{ text: { content: (n.answers[0] || "").slice(0, 2000) } }] },
    "What Went Wrong / 出现的问题": { rich_text: [{ text: { content: (n.answers[1] || "").slice(0, 2000) } }] },
    "Improvement Suggestions / 改善建议": { rich_text: [{ text: { content: (n.answers[4] || n.answers[n.answers.length - 1] || "").slice(0, 2000) } }] },
    "Submission Date / 提交日期": { date: { start: timestamp.slice(0, 10) } },
    "Submitted By / 提交人": { rich_text: [{ text: { content: (n.submittedBy || "").slice(0, 200) } }] },
    "Human Verification Status / 人工核实状态": { select: { name: "Not Verified / 未核实" } },
  };
  if (n.crewFunction && CREW_NOTION[n.crewFunction]) {
    props["Crew Function / 工作职能"] = { select: { name: CREW_NOTION[n.crewFunction] } };
  }
  if (EVENT_PAGE[n.eventId]) {
    props["Event / 赛事"] = { relation: [{ id: EVENT_PAGE[n.eventId] }] };
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
    const t = await resp.text();
    throw new Error(`Notion ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  return { ok: true, pageId: data.id };
}

module.exports = async (req, res) => {
  // CORS preflight from the browser page (different Vercel origin).
  // Without this, the browser blocks the POST even though curl works.
  if (req.method === "OPTIONS") {
    res.status(200);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.end();
  }
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  try {
    const n = normalise(req.body);
    if (!n.eventId || !n.role || !n.answers || n.answers.length === 0) {
      return json(res, 400, { error: "eventId, role and answers[] are required" });
    }
    if (!["Player", "Event Crew", "Organizer"].includes(n.role)) {
      return json(res, 400, { error: "role must be Player, Event Crew or Organizer" });
    }
    const timestamp = new Date().toISOString();
    const row = [
      timestamp,
      n.eventId,
      n.role,
      n.crewFunction || "",
      n.language || "en",
      n.rating === null ? "" : n.rating,
      ...[0, 1, 2, 3, 4].map((i) => n.answers[i] || ""),
    ];

    if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      return json(res, 200, {
        ok: false,
        stored: "not-configured",
        message: "Sheets not configured yet — keep the Copy/Download record, nothing is lost.",
        record: { eventId: n.eventId, role: n.role, rating: n.rating, answers: n.answers, submittedAt: timestamp },
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

    // Auto-write to the Notion Feedback database as well (best-effort).
    let notion = { skipped: true };
    try {
      notion = await writeToNotion(n, timestamp);
    } catch (e) {
      notion = { ok: false, error: String(e.message || e).slice(0, 200) };
    }
    return json(res, 200, {
      ok: true,
      stored: "sheet",
      notion: notion.ok ? "notion" : notion.skipped ? "skipped" : "failed",
      notionError: notion.error || undefined,
      eventId: n.eventId,
      role: n.role,
    });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
};
