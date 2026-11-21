# Implementation status

## Implemented in code

- Workspace-scoped rule, example, feedback and learning-suggestion models plus migration.
- Rule/example APIs and role-gated training UI.
- Frozen-snapshot rule/example context, bounded lexical example retrieval, untrusted example wrapping and deterministic configured trigger-term checks.
- Evidence-linked opportunity analysis constrained to supplied claim IDs.
- Feedback scope, repeated-edit heuristic suggestions and explicit admin acceptance.
- Focused deterministic unit coverage and technical documentation.

## Verified locally

- `npm run typecheck` — passed.
- `npx prisma validate` — passed.
- `npm run build` — passed.
- `npm run build:frontend` — passed (existing Next.js warning about multiple lockfiles).
- `npm run openapi` — passed; current API spec reports 273 paths / 335 operations.
- Current source inventory: 86 frontend `page.tsx` route entries (dynamic route parameters counted once).
- `tests/unit/shared.test.ts` — 13 passed.

## Not verified / deployment gates

- Apply migration to an isolated PostgreSQL database; verify migration compatibility, role grants, CRUD, tenant isolation, backup/restore and restart persistence.
- Run DB-backed integration and full unit suites. The configured PostgreSQL is unavailable; the full unit runner stalled.
- Build/start Docker services and verify health/restart behavior. Docker CLI is not available in this shell.
- Run browser UI/API workflows. Local app at port 3000 is not running.
- Verify providers with safe credentials and a controlled test mailbox. No real prospect sends were made.
- Create and independently human-review a 50-scenario anonymized benchmark from authorized customer data. None was supplied.
- Evaluate accuracy, latency, cost and provider-specific schema behavior with representative configurations.

Do not treat code presence, mocked provider calls, or deterministic unit tests as proof that the production workflow works end to end.
