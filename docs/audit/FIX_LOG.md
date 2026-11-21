# Fix log

## FIX-001 — enforce workspace ownership for mailbox ingestion

- **Severity:** High (cross-tenant integrity/security).
- **Root cause:** `ingestMessages()` loaded `EmailAccount` by primary key only while accepting a separate `workspaceId` used for message, conversation, and attachment writes.
- **Files changed:** `backend/src/services/inbox.ts`; `tests/integration/inbox-replies.test.ts`.
- **Correction:** Query by `{ id: accountId, workspaceId }`; return the standard 404 when not found. Added regression test using two workspace sessions and a mailbox owned by the other workspace, asserting no message is written.
- **Verification:** `npm run typecheck` PASS; `npm run build` PASS; `npm run lint` PASS with 8 warnings. Integration test NOT RUN because `npm test` global migration setup cannot connect to PostgreSQL.

## FIX-002 — serialize initial owner registration

- **Severity:** Medium (initial privilege assignment race).
- **Root cause:** User count and duplicate-email check were performed before the registration transaction.
- **Files changed:** `backend/src/services/auth.ts`; `tests/integration/auth-isolation.test.ts`.
- **Correction:** Acquire a transaction-scoped PostgreSQL advisory lock, then recheck user count and email uniqueness inside the transaction before creating user/workspace/member records.
- **Verification:** Typecheck/build/lint pass. Added concurrent two-request test expecting one 201 and one 403; test execution BLOCKED because PostgreSQL is unavailable.

## FIX-003 — restore Compose runtime audit fixes

- **Severity:** High/Medium.
- **Root cause:** Current Compose source was found reverted to invalid YAML, single DB role and internal browser API target while carrying newer migration files.
- **Files changed in this task:** `docker-compose.yml`, `.env.example`, `deployment/docker/postgres-init/001-runtime-role.sh`, `README.md`. `frontend/next.config.mjs`, `scripts/migrate-compose.ts`, `deployment/docker/Dockerfile.migrate` existed in the workspace from prior work.
- **Correction:** restored separate DB credentials/runtime role init, password-protected Redis without direct password argument, migration-before-app dependencies, API/web checks, isolated-project commands and local setup guidance.
- **Verification:** YAML parser PASS; Docker runtime NOT TESTED because Docker is unavailable. Role grants and browser API rewrite remain unverified at runtime.
