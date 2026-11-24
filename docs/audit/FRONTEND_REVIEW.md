# Frontend review

Static inventory only: 98 source pages. This does not imply each page/action was exercised in a browser; browser behavior remains NOT TESTED in this continuation.

Current route page count: **98** `page.tsx` files under `frontend/app`. Browser interactions are implemented mainly in each page with `frontend/lib/api.ts`, TanStack Query hooks in `frontend/lib/hooks.ts`, and shared components in `frontend/components`.

| Page file | Verification status |
|---|---|
| `frontend/app/admin/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/forgot-password/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/invite/[token]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/login/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/oauth-error/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/reset-password/[token]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/select-workspace/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/setup/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/u/[token]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/ai-studio/knowledge/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/ai-studio/models/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/ai-studio/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/ai-studio/profiles/[id]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/ai-studio/profiles/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/ai-studio/research/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/ai-studio/writing/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/analytics/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/automations/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/billing/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/campaigns/[id]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/campaigns/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/companies/[id]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/companies/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/copilot/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/domains/[id]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/domains/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/email-accounts/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/enrichment/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/followups/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/icps/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/inbox/[id]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/inbox/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/leads/[id]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/leads/import/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/leads/lists/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/leads/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/mailbox-health/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/notifications/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/pipeline/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/prospecting/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/reply-assistant/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/reports/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/research/[id]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/research/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/account/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/ai/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/api-keys/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/audit/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/compliance/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/general/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/integrations/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/jobs/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/logs/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/policies/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/privacy/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/suppression/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/team/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/settings/webhooks/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/tasks/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/usage/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/workflows/[id]/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/workflows/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |
| `frontend/app/w/[ws]/writing/page.tsx` | BLOCKED for live API/persistence; source page exists, route rendering not exercised in this audit |

## Shared UX and API infrastructure

- API calls use relative `/api/v1` paths, same-origin cookies, and CSRF header on unsafe methods (`frontend/lib/api.ts`).
- `frontend/lib/hooks.ts` centralizes React Query invalidation and data hooks.
- `frontend/components/ui.tsx`, `auth-shell.tsx`, `toast.tsx`, `review-panel.tsx`, `security.tsx`, `ai-studio.tsx` and domain-specific components provide shared controls.
- `frontend/next.config.mjs` uses a server-side Next rewrite. Browser requests remain relative; Compose supplies the internal API target at build. Actual Docker proxy behavior is not runtime-verified.
- A source count cannot establish every visible button’s behavior. Per-page click, validation, refresh and error-state checks remain outstanding.
