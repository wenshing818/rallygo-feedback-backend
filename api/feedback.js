// TER — AI-Assisted Feedback backend (Vercel Serverless, Node)
// POST /api/feedback
// Body from the public chat page (no keys in the frontend):
// {
//   eventId: "TER-2026-1114-KALLANG",
//   role: "Player" | "Event Crew" | "Organizer",
//   language: "en" | "zh",
//   answers: [{ question: "...", answer: "..." | null }], // null = skipped
//   crewFunction?: "Umpire" | "Volunteer" | "Both" | "Other"
// }
//
// Env vars (Vercel Dashboard > Settings > Environment Variables — never commit):
//   GEMINI_API_KEY      — new Auth key from Google AI Studio, restricted to Gemini API only
//   NOTION_TOKEN        — internal integration token, shared with Feedback DB only
//   NOTION_FEEDBACK_DATA_SOURCE_ID — 4197fbb0-0e7d-812f-be51-000b4993f9a7
//   GEMINI_MODEL        — optional, default gemini-3.5-flash-lite
//
// Design for the free tier (verified 15 Nov 2026):
// - ONE Gemini call per confirmed submission, at the summary step only.
//   The 5 questions are scripted in the frontend; Gemini is NOT called per turn.
//   That is what makes ~16 real participants fit in a ~20/day free quota.
// - Primary model: gemini-3.5-flash-lite — answered in ~1s in the Muse test on
//   15 Nov 2026. Fallback: gemini-3.8-flash (timed out once after 60s in test,
//   so keep the timeout short and fall back to the local summary, never hang).
// - gemini-2.5-flash is NOT used: Google returns 404 for new users, recommends 3.8.
// - No rating is ever invented. Suggested Rating is set only if the user typed
//   an explicit number like "4/5" / "4分".
// - Original answers and the AI summary are stored in separate Notion fields.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GEMINI_FALLBACK_MODEL = "gemini-3.8-flash";
const NOTION_VERSION = "2025-09-03";

function json(res, status, obj) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.json(obj);
}

function localSummary(answers, language) {
  // Honest fallback when Gemini is unavailable / quota exhausted.
  // Built ONLY from the user's own words — no invented facts or ratings.
  const lines = answers
    .filter((a) => a.answer && String(a.answer).trim())
    .map((a) => `- ${String(a.answer).trim()}`);
  const text = lines.length ? lines.join("\n") : "(no answers given)";
  return {
    summary: language === "zh"
      ? `用户原话要点：\n${text}`
      : `Key points in the user's own words:\n${text}`,
    sentiment: "Mixed",
    categories: [],
    improvements: [],
    confidence: "Low",
    source: "local-fallback",
  };
}

async function callGemini(model, answers, role, eventId, language) {
  const prompt = [
    "You summarise tennis tournament feedback. Use ONLY the answers below.",
    "Do not invent scores, ratings, facts, names, or events not stated.",
    "If the user gave an explicit rating like '4/5', include it. Otherwise rating must be null.",
    "Reply with JSON only, no markdown, no extra text:",
    '{"summary":"1-3 sentences, same language as the answers","sentiment":"Positive|Mixed|Negative","categories":["Scheduling","Venue","Communication","Organization","Rules and Scoring"],"improvements":["..."],"rating":null,"confidence":"High|Medium|Low"}',
    `Event: ${eventId} | Role: ${role} | Language: ${language}`,
    "Answers:",
    ...answers.map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer ?? "[skipped]"}`),
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000); // 20s — do not hang a mobile user
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 600, responseMimeType: "application/json" },
      }),
      signal: ctrl.signal,
    });
    const data = await r.json();
    if (!r.ok) {
      const err = new Error(`Gemini ${r.status}: ${JSON.stringify(data).slice(0, 400)}`);
      err.status = r.status;
      throw err;
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const parsed = JSON.parse(text);
    return { ...parsed, source: `gemini:${model}` };
  } finally {
    clearTimeout(timer);
  }
}

// FIX 15 Nov 2026: DB4 property names and select options are bilingual in Notion
// (verified by fetching data source 4197fbb0-0e7d-812f-be51-000b4993f9a7).
// Short English names ("Player", "Mixed", "High") are NOT valid option names
// and the title property is "Feedback / 反馈", not "title". The previous
// version would have failed every Notion write with a validation error.
const ROLE_MAP = { Player: "Player / 球员", "Event Crew": "Event Crew / 赛事工作人员", Organizer: "Organizer / 组织者" };
const SENTIMENT_MAP = { Positive: "Positive / 正面", Neutral: "Neutral / 中性", Negative: "Negative / 负面", Mixed: "Mixed / 混合" };
const CONFIDENCE_MAP = { High: "High / 高", Medium: "Medium / 中", Low: "Low / 低" };
const CATEGORY_MAP = { Organization: "Organization / 组织", Communication: "Communication / 沟通", Scheduling: "Scheduling / 赛程", Venue: "Venue / 场地", Rules: "Rules / 规则", "Rules and Scoring": "Rules / 规则", Other: "Other / 其他" };
const CREW_MAP = { Umpire: "Umpire / 裁判", Volunteer: "Volunteer / 志愿者", Both: "Both / 两者", Other: "Other / 其他" };
const EVENT_PAGE_MAP = { "TER-2026-1114-KALLANG": "4197fbb0-0e7d-816b-9c32-f307c1465f99" };

async function saveToNotion(payload, ai) {
  const originalText = payload.answers
    .map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer ?? "[skipped]"}`)
    .join("\n\n");

  // Keep every rich-text field under Notion's 2,000-char limit per text object.
  const clip = (s) => String(s || "").slice(0, 1900);
  const ans = (i) => (payload.answers[i] && payload.answers[i].answer) || "";

  const properties = {
    "Feedback / 反馈": { title: [{ type: "text", text: { content: `${payload.role} — ${payload.eventId} — ${new Date().toISOString().slice(0, 10)}` } }] },
    "Submitted By / 提交人": { rich_text: [{ type: "text", text: { content: "Public feedback page" } }] },
    "Role / 角色": { select: { name: ROLE_MAP[payload.role] || payload.role } },
    "Submission Date / 提交日期": { date: { start: new Date().toISOString().slice(0, 10) } },
    "AI Summary / AI摘要": { rich_text: [{ type: "text", text: { content: clip(ai.summary) } }] },
    "AI Sentiment / AI情感": { select: { name: SENTIMENT_MAP[ai.sentiment] || "Mixed / 混合" } },
    "AI Category / AI分类": { multi_select: (ai.categories || []).slice(0, 5).map((name) => ({ name: CATEGORY_MAP[name] || name })) },
    "AI Confidence / AI置信度": { select: { name: CONFIDENCE_MAP[ai.confidence] || "Low / 低" } },
    "Human Verification Status / 人工核实状态": { select: { name: "Not Verified / 未核实" } },
    "What Went Well / 做得好的地方": { rich_text: [{ type: "text", text: { content: clip(ans(1) || ans(0)) } }] },
    "What Went Wrong / 出现的问题": { rich_text: [{ type: "text", text: { content: clip([ans(2), ans(3)].filter(Boolean).join(" ") || ans(0)) } }] },
    "Improvement Suggestions / 改善建议": { rich_text: [{ type: "text", text: { content: clip((ai.improvements || []).join("; ") || ans(4)) } }] },
    "Anonymous / 匿名": { checkbox: false },
  };
  if (payload.crewFunction) {
    properties["Crew Function / 工作职能"] = { select: { name: CREW_MAP[payload.crewFunction] || payload.crewFunction } };
  }
  if (EVENT_PAGE_MAP[payload.eventId]) {
    properties["Event / 赛事"] = { relation: [{ id: EVENT_PAGE_MAP[payload.eventId] }] };
  }
  // Full original Q&A goes in the page body, separate from the AI summary fields.
  const children = [
    { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "Original responses / 原始回答" } }] } },
    ...payload.answers.map((a, i) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: clip(`Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer ?? "[skipped]"}`) } }] } })),
  ];

  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: process.env.NOTION_FEEDBACK_DATA_SOURCE_ID },
      properties,
      children,
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Notion ${r.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
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
    if (!process.env.GEMINI_API_KEY || !process.env.NOTION_TOKEN || !process.env.NOTION_FEEDBACK_DATA_SOURCE_ID) {
      return json(res, 500, { error: "Backend is not configured yet (missing env vars). Submission was not saved." });
    }

    let ai;
    try {
      ai = await callGemini(GEMINI_MODEL, b.answers, b.role, b.eventId, b.language || "en");
    } catch (e1) {
      // 429 = free quota exhausted, 404 = model retired — try the fallback once, then local.
      if (e1.status === 429 || e1.status === 404) {
        try { ai = await callGemini(GEMINI_FALLBACK_MODEL, b.answers, b.role, b.eventId, b.language || "en"); }
        catch { ai = localSummary(b.answers, b.language || "en"); ai.quotaNote = "Gemini quota/model unavailable — local summary used, originals preserved."; }
      } else {
        ai = localSummary(b.answers, b.language || "en");
        ai.quotaNote = "Gemini unavailable — local summary used, originals preserved.";
      }
    }

    const page = await saveToNotion(b, ai);
    return json(res, 200, {
      ok: true,
      notionPageId: page.id,
      ai: { summary: ai.summary, sentiment: ai.sentiment, categories: ai.categories, confidence: ai.confidence, source: ai.source, quotaNote: ai.quotaNote || null },
    });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
};
