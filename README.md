# TER Feedback Backend

Node serverless API for RallyGo / Tennis123 — collects post-event feedback from community tennis tournaments.

Endpoints:
- POST /api/submit — fast save of one Q&A submission to Google Sheets (no Gemini call)
- POST /api/aggregate — owner-triggered Gemini summary, one report to Notion per 50 rows
- POST /api/feedback — legacy per-submission Gemini + Notion

Deployed on Vercel (Hobby) at https://ter-feedback-backend.vercel.app
