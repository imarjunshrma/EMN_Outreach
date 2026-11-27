# Knowledge Importer implementation

## Repository changes

- The importer API and workers are in `backend/src/services/knowledge-import*.ts`, `backend/src/routes/ai-studio.ts`, and `worker/src/{main,processors}.ts`.
- Workspace AI routing, prompt definitions, and shared output schemas are in `backend/src/services/ai.ts` and `shared/src/{knowledge-import,ai-studio,prompts}.ts`.
- Destination integration uses `business-knowledge.ts`, `ai-studio.ts`, `outreach-brain.ts`, `icp-versions.ts`, and the `knowledge-records.ts` API. The import changes also extend audit, Copilot, intelligence, personalization, and compliance.
- AI Studio imports and structured knowledge records are under `frontend/app/w/[ws]/ai-studio/`. The browser workflow is in `e2e/knowledge-import.spec.ts` and its isolated Playwright config.

## Processing and review

The v2 template has 13 entity worksheets and an Instructions sheet. XLSX, CSV, PDF, DOCX, TXT, Markdown, JSON, and HTML parsers preserve source locations. Extraction uses the workspace’s configured model and a captured prompt version. The worker validates structured fields and source excerpts, then computes destination and duplicate proposals. Uploaded statements retain their source classification and unverified status.

Nine stages run on the existing BullMQ import queue. Stage and run IDs guard retries. PostgreSQL stores the stage checkpoint and the maintenance worker reconciles interrupted queue publication. Cancellation is available before parsing starts.

The AI Studio review screen shows provenance, existing and proposed fields, changes in conflict, and duplicate candidates. Administrators can edit, approve, reject, skip, or add notes. Bulk decisions support rejection and skipping. Application runs in a separate queue stage and rechecks actor authority and destination version inside the transaction. Services and proof enter their native draft and review workflows. Eligible records update tracked documents and use the existing vector index. Copilot, research, qualification, personalization, and outreach consume eligible structured knowledge through their existing flows.

## Database

- `20261127120000_knowledge_importer` is the existing session, file, and item migration.
- `20261127120200_business_knowledge_records` adds workspace records and revisions.
- `20261127120300_icp_revisions` adds ICP version history.
- `20261127120500_knowledge_import_extraction` adds the extraction AI task.
- `20261127121000_knowledge_import_pipeline` adds durable worker and review state.
- `20261127122000_knowledge_import_integrity` adds workspace-aware foreign keys, structured provenance, and cancellation.

The development database was backed up in readable SQL and restored into a separate verification database. The restore returned 33 migration records and four workspaces. All 39 migrations and the repository’s supporting SQL applied in the isolated acceptance database.

## Verification

The focused Vitest suite passed 30 parser, routing, retrieval, workflow, and test safety checks using isolated PostgreSQL and Redis. AI and embedding responses are synthetic at the provider boundary. The vector query and PostgreSQL writes use actual infrastructure.

The Playwright acceptance scenario passed using Chrome, the real API and UI, a real BullMQ worker, and a loopback AI fixture. It downloaded the workbook, uploaded all entity worksheets with a support DOCX, reviewed and edited proposals, applied approved records, verified the native service approval and audit history, queried Copilot, checked research and personalization eligibility, re-imported the same files, and surfaced a changed service as a conflict.

Verification commands included `npm run build`, `npm run typecheck`, `npm --prefix frontend run typecheck`, the focused `npm test --` suite, `npx playwright test --config playwright.knowledge-import.config.ts`, and `git diff --check`.

## Current limits

- Production AI credentials and live provider responses were outside the acceptance run.
- Cyclic relationships require review. Ambiguous duplicate matches require editing or skipping a proposal. Similarity suggestions use text matching and never merge records on that basis.
- The browser scenario applied a representative subset of destinations. The integration suite additionally exercised commercial offers, ICP revisions, campaign preferences, and exclusions.

## Production-readiness follow-up

The route now caps retained multipart file bytes at 40 MB across the request and keeps the 20 MB per-file limit. The parser worker reads one file body at a time. A file that exceeds the extraction batch limit gets its own failure while other files continue. Cancellation is cooperative during parsing, extraction, and schema validation. An already-started provider request can finish, and its result cannot reactivate the cancelled import.

The queue reconciler also handles a completed Redis job whose PostgreSQL checkpoint is still active. It advances the run generation and enqueues the same checkpoint under a fresh job ID. Final application status and its audit entry commit together. Dependency ordering applies acyclic relationships first. Cycles and blocked dependents return to review with an explanation and editable references. A skipped proposal can satisfy a relationship only if it still matches its current destination.

This follow-up changed the importer route, storage and review service, worker, destination adapter, review screen, verification script, and focused integration tests. It added no migrations and amended no existing migration history.

### Destination coverage

| Entity | Application path | Acceptance evidence |
| --- | --- | --- |
| Company profile | Knowledge configuration version | Browser and integration |
| Service | Native service draft and approval | Browser and integration |
| Commercial offer | Versioned commercial offer in Knowledge configuration | Integration |
| Target audience | Versioned workspace knowledge record | Browser and integration |
| Target persona | Versioned record with audience reference | Integration |
| ICP criteria | Native ICP revision | Integration |
| Business opportunity | Versioned workspace knowledge record | Integration |
| Competitor | Versioned workspace knowledge record | Integration |
| Research rule | Versioned record and research configuration | Integration |
| Outreach rule | Native outreach rule | Integration |
| Exclusion | Versioned record and eligibility check | Integration |
| Proof and case study | Unverified evidence record, native proof draft when linked | Unverified record and retrieval exclusion tested |
| Campaign preference | Versioned campaign reference record | Integration |

Coverage refers to the scenarios executed. It does not imply field-by-field verification or every lifecycle branch.

### Production configuration and operations

Use the existing database and Redis settings and deploy the API, frontend and worker from the same revision. Enable the shared import and maintenance queues. Apply the normal Prisma migrations and repository SQL with an owner-capable migration account. PostgreSQL needs the vector, trigram and unaccent extensions. Configure the workspace extraction route and encrypted credentials in AI Settings. Configure a supported embedding provider and model using the existing embedding settings in `.env.example` if vector indexing is required.

The import detail page exposes the current stage, file and item failures, and retry controls. Platform Operations exposes BullMQ failures. Investigate a stalled import by matching session ID, stage and run generation between PostgreSQL and the queue. Keep import logs and the readable SQL backup in restricted storage. The deployment proxy should allow multipart requests up to 40 MB of file data plus multipart framing.

### Follow-up commands and results

| Command | Result |
| --- | --- |
| `npm run build` | Passed |
| `NEXT_DIST_DIR=.next-readiness NEXT_TELEMETRY_DISABLED=1 npm run build:frontend` | Passed with existing warnings outside the importer |
| `npm run typecheck` and `npm --prefix frontend run typecheck` | Passed |
| `npm test -- tests/unit/knowledge-import-extraction.test.ts tests/unit/warmup-test-safety.test.ts tests/integration/knowledge-import-ai.test.ts tests/integration/knowledge-import-retrieval.test.ts tests/integration/knowledge-import-workflow.test.ts` | 33 passed using the loopback acceptance database, Redis DB 12, mock email, and application AI fixtures |
| `npx prisma migrate status` | 39 migrations recognized and isolated schema up to date |
| `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npx playwright test --config playwright.knowledge-import.config.ts` | One scenario passed on rerun after clearing generated build artifacts to resolve host disk exhaustion |
| `npx eslint backend/src/routes/ai-studio.ts backend/src/services/knowledge-import*.ts scripts/knowledge-import-provider-smoke.ts tests/helpers/harness.ts tests/integration/knowledge-import*.test.ts 'frontend/app/w/[ws]/ai-studio/imports/[id]/page.tsx' 'frontend/app/w/[ws]/ai-studio/imports/page.tsx'` | Passed |
| `npm run lint` | Passed with 23 warnings and zero errors |
| `git diff --check` | Passed |
| `node --env-file=.env --import tsx scripts/knowledge-import-provider-smoke.ts` | Stopped safely before a provider call. Dedicated non-production workspace ID and configured API route were unavailable. |

For the live smoke, set `DATABASE_URL` to the loopback `outvexa_knowledge_import_acceptance` database and set `KNOWLEDGE_IMPORT_SMOKE_WORKSPACE_ID` to a dedicated workspace named with the prefix `Knowledge Import Provider Smoke`. Configure a non-production API provider in that workspace. The smoke sends only small synthetic rows and reports entity coverage and usage metadata. It creates no destination records.

### Remaining verification gaps

- Live extraction, provider fallback and live-provider rate-limit and timeout behavior remain unverified.
- The focused recovery test verifies Redis completion without a PostgreSQL checkpoint. Forced worker termination, Redis outage/reconnect and production load remain unverified.
- Cancellation and cycle recovery are covered at the worker and API-service level. Browser acceptance remains one representative workflow and does not exercise every recovery or destination branch.
- Cycles require explicit edits or staged review by an administrator. The importer does not automatically create mutually dependent records.

**NOT READY**

## Release-gate verification

### Defects corrected

- An import could commit to PostgreSQL and leave the submitting request waiting indefinitely for BullMQ during an outage. Upload, apply and retry now bound the initial queue publication to 1.5 seconds. A deferred publication logs only the workspace, session, stage and run. The maintenance reconciler republishes the durable checkpoint. Redis queue IDs are still derived from the same session, run and stage.
- The upload admission limiter could wait indefinitely for Redis before reaching the importer. This route now returns a bounded HTTP 503 on admission failure and keeps its rate limit enforced. The outage scenario below exercised committed service-level submissions, so the HTTP 503 path has type/build coverage and has yet to be fault-injected through a browser or API test.
- The provider smoke can now create a dedicated synthetic workspace, encrypt and register a non-production OpenAI key through the existing provider service, set the extraction route, and check model-list connectivity before extraction. The script writes no destination records.

### Worker and Redis evidence

`scripts/knowledge-import-recovery-smoke.ts` started a disposable loopback Redis 8.4.0 process and child BullMQ workers against the isolated PostgreSQL acceptance database. It sent SIGKILL to the worker after BullMQ took the parse job, and again in a separate run after the parse checkpoint committed but before BullMQ acknowledged it. New workers recovered the stalled delivery in both cases. Each run persisted one parsed file and applied zero proposals.

A separate SIGKILL occurred after approved application committed and before the queue acknowledgment. The replacement worker replayed the stalled delivery. The destination had exactly one revision and one application audit event, and the unapproved proposal stayed in review. The replacement worker ran embedding with no external embedding provider configured, then retrieval sync, and the session reached APPLIED. This test verified the application boundary, while the existing retrieval tests independently exercised pgvector and approval filtering.

The harness then sent SIGKILL to Redis while a worker was connected. A submission committed while Redis was unavailable and returned in **1,506 ms**. Redis restarted on the same isolated port with an empty queue. The connected worker re-established its connection, reconciliation recreated missing jobs, and the submission reached extraction. The run observed three worker connection errors during the outage. The test intentionally disabled persistence for this Redis instance to exercise queue loss. Deployment Compose uses AOF and a persistent volume.

### Local concurrency measurement

The Mac test host had 10 logical CPUs and 16 GiB RAM. Four synthetic workspaces submitted eight concurrent requests at the service layer. Each pair re-imported the same six-sheet workbook of 2,100 rows and one TXT supplement. The workbook was 1,079,782 bytes. One parse worker produced **four distinct sessions and eight parsed files**, with no extra records from duplicate uploads. Service submission took **84 ms**, and all four sessions reached extraction in **337 ms**. Peak harness RSS was **395 MiB**, with **390,579 µs user CPU** and **25,802 µs system CPU**. The harness asserts one session per duplicate pair, eight parsed files, and completion within the polling deadline. These measurements exclude HTTP transfer and downstream model work. Deployment-specific capacity and resource budgets were unavailable, so these values are a local baseline.

### Provider prerequisite

No approved non-production API key or configured smoke workspace was available. The provisioning command exited before creating a workspace or making a provider request. The precise inputs are a non-production OpenAI project API key authorized to list models and create inference requests, in `KNOWLEDGE_IMPORT_SMOKE_OPENAI_KEY`, and the allowed model ID in `KNOWLEDGE_IMPORT_SMOKE_OPENAI_MODEL`. Supply the values through the environment or approved secret injection, with a valid existing application encryption keyring and the isolated database URL. The alternate path accepts an already configured dedicated workspace ID. There is no live provider/model attribution, usage, cost, repair, timeout or fallback evidence from this run.

### Lint disposition

The two AI Settings warnings were corrected by typing the configured provider list and connection-test response and making the default-provider effect depend on the value it reads. The retained warnings were reviewed at their reported sites. OpenAPI has two type-erasure warnings and the generic router has ten; these describe the heterogeneous route registry and handler dispatch. Domains/enrichment has two boundary-type warnings and verification CSV has two local type-narrowing warnings. The enrichment batch page has two display-data type warnings. The remaining voice, playbook editor, and workflow builder warnings concern hook cleanup, keyed editor state, and query fallback identity. Those lifecycle changes require feature-specific validation and are outside this importer release. No lint rule was changed.

### Deployment and rollback

Deploy the API and both the import and maintenance workers together. Monitor queue age, Redis reconnect errors, deferred publications and PostgreSQL sessions stuck on the same stage. Keep AOF, the Redis volume, and the no-eviction policy enabled. Verify the workspace extraction route and worker connectivity before opening uploads. This release introduced no schema changes. For rollback, quiesce new uploads, allow application transactions to settle, then roll the API and worker back together. Preserve the queue volume and committed checkpoints. An older worker may need its stage compatibility checked before resuming queued work.

### Release verification commands

- `node --import tsx scripts/knowledge-import-recovery-smoke.ts` with `DATABASE_URL` pointed at the loopback acceptance database and `EMN_ENV_FILE=/dev/null` · passed the parse and application kill scenarios, Redis restart and parser concurrency workload.
- `node --import tsx scripts/knowledge-import-provider-smoke.ts --provision-openai` against the same isolated database · exited before provider calls because the non-production key and model were unavailable.
- The five-file `npm test --` command in the follow-up table · 33 passed with the existing isolated Redis DB 12 and mock email settings.
- `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npx playwright test --config playwright.knowledge-import.config.ts` · one workflow passed.

- `npm run build` and `NEXT_DIST_DIR=.next-readiness NEXT_TELEMETRY_DISABLED=1 npm run build:frontend` · passed.
- `npm run typecheck` and `npm --prefix frontend run typecheck` · passed.
- `npm run lint` · passed with zero errors and 21 retained warnings after removing temporary frontend build output.
- `git diff --check` · passed.

### Open release gates

Other stage-specific crashes, connection loss during an active provider or embedding request, full production-like load including large PDF/DOCX and the complete AI/indexing pipeline, and the live non-production provider are still unverified. The release evidence does not establish production capacity or complete fault-injection coverage.

**NOT READY**
