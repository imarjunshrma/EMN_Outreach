# AI Outreach Brain API

All endpoints use the existing authenticated workspace API prefix `/api/v1/w/:workspaceId`. Workspace ID is taken from authorized request context. Read routes allow VIEWER; mutations require ADMIN.

Generated inventory currently contains 335 registered operations across 273 OpenAPI paths. See root `API_DOCUMENTATION.md` and `docs/openapi.json` for the full, generated reference.

| Method | Path | Purpose |
|---|---|---|
| GET | `/ai-outreach-brain/overview` | Counts and generation latency |
| GET, POST | `/ai-outreach-brain/rules` | List rules/conflicts; create rule |
| PATCH, DELETE | `/ai-outreach-brain/rules/:id` | Update or delete rule |
| GET, POST | `/ai-outreach-brain/examples` | List or add text example |
| PATCH, DELETE | `/ai-outreach-brain/examples/:id` | Update or delete example |
| GET | `/ai-outreach-brain/suggestions` | List pending learning suggestions |
| POST | `/ai-outreach-brain/suggestions/:id/decision` | Accept or reject suggestion |

Personalization edits use the existing `PATCH /personalizations/:id` route and accept optional `feedbackNote` and `feedbackScope` (`GLOBAL`, `CAMPAIGN`, `PROSPECT`, `FACTUAL`). Default scope is `CAMPAIGN`. Full schemas and current routes are generated in `docs/openapi.json` by `npm run openapi`.
