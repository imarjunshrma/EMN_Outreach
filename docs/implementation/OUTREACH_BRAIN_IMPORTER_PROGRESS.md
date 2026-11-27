# Knowledge Importer implementation

This report replaces the earlier progress notes and their two "NOT READY" verdicts. It records the release state on 27 November 2026, after the production-readiness work. Every result below comes from a command that was executed. Nothing was inferred from a build alone.

## 1. Final architecture and processing flow

The importer extends the existing system. It adds no parallel knowledge store, approval workflow, retrieval index or provider path.

- **Upload.** `POST /ai-studio/imports` in `backend/src/routes/ai-studio.ts` accepts up to 40 MB of file data per request and 20 MB per file. The rate limit is enforced, and admission is bounded to an HTTP 503 if Redis is unavailable. Files are checked by content signature and MIME type, decompression size is bounded, and names are sanitized. Files are stored on the `KnowledgeImportFile` row. A live SHA-256 unique index (`KnowledgeImportFile_live_sha256_key`) makes a re-upload return the existing session. Cancelled files are excluded from this check.
- **Queue.** Nine stages run on the dedicated BullMQ queue `knowledge-import` (`QUEUES.knowledgeImport`), through the existing `enqueue`, worker registry and fair-queue machinery:
  1. `IMPORT_FILE_PARSE`
  2. `IMPORT_EXTRACTION`
  3. `IMPORT_SCHEMA_VALIDATION`
  4. `IMPORT_SEMANTIC_MAPPING`
  5. `IMPORT_DUPLICATE_DETECTION`
  6. `IMPORT_CONFLICT_DETECTION`, after which the session moves to REVIEW
  7. `IMPORT_APPROVED_APPLICATION`
  8. `IMPORT_EMBEDDING`
  9. `IMPORT_RETRIEVAL_SYNC`
- **Checkpoint.** PostgreSQL is the source of truth. `processingStep` plus a `run` generation guards every write, so a replayed or stale delivery is a no-op. The initial queue publication is bounded to 1.5 seconds. Otherwise the maintenance reconciler (`recoverImportJobs`) republishes from the checkpoint. It also advances the run when Redis completed a job whose checkpoint stayed active.
- **Parsing.** XLSX, CSV, PDF, DOCX, TXT, Markdown, JSON and HTML parsers keep source locations such as `Sheet:row-N` and `paragraph-N`. HTML scripts and event handlers are stripped. CSV formulas stay inert text. XLSX is read with `read-excel-file` and written with an in-repo `jszip` writer (see section 2).
- **Extraction.** Extraction uses `runAi` with the workspace's AI-source routing (`resolveAiSource`). Source text is wrapped with `wrapUntrusted`, and excerpts are validated with one repair attempt. A file whose content cannot be extracted (`VALIDATION_FAILED` 400 or `AI_OUTPUT_INVALID`) fails on its own while other files continue. Provider and transport errors fail the stage, which the queue retries 3 times with exponential backoff before the session becomes FAILED with a retry control.
- **Validation, mapping and review.** Invalid records become NEEDS_REVIEW with a per-file note; they no longer fail the import. Records with neither an external ID nor a name get no stable key, so they are not grouped. Prompt-injection heuristics in `inspectImportItem` send suspicious records to review. Administrators edit, approve, reject, skip or annotate records; bulk reject and skip are available. Conflicts need an explicit acknowledgement before approval.
- **Application.** Application runs as a queue stage. Each item is applied in its own serializable transaction that rechecks `assertImportAdmin`, the session run and the item version, then calls the native destination services: `saveConfig`, `createService`, `saveIcpVersion`, `createRule`, `addProof`, and `businessKnowledgeRecord` with revisions. A serialization conflict between concurrent tenants (Prisma `P2034`) is retried up to 5 times inside the stage. Relationships are applied in dependency order. Cycles and blocked dependents return to review with an explanation and editable references.
- **Retrieval.** Only eligible records become `knowledgeDocument` rows indexed through `indexMemoryItems` / `searchMemory`: EXPLICIT_FACT records, plus CLAIM for offers and RECOMMENDATION for non-outbound types. Rejected, skipped, unapproved and unverified content is excluded from Copilot, research and personalization.

## 2. All changed files

Relative to the pre-release tree.

| File | Change |
| --- | --- |
| `backend/src/services/knowledge-import-xlsx.ts` (new) | Minimal XLSX writer on `jszip` (inline strings, column widths, header notes). It replaces SheetJS `xlsx` 0.18.5 at runtime, which has advisories GHSA-4r6h-8v6p-xvw6 and GHSA-5pgg-2g8v-p4x9 and no fixed npm release. |
| `backend/src/services/knowledge-import-parser.ts` | Reads XLSX with `read-excel-file` (sheet, row and column limits; dates as ISO; formulas as stored values). `templateWorkbook()` is async. |
| `backend/src/routes/ai-studio.ts` | Awaits the async template workbook. |
| `backend/src/services/knowledge-import.ts` | Uses the dedicated queue. The reconciler looks up jobs in both the new and the legacy queue. |
| `backend/src/services/knowledge-import-worker.ts` | Four fixes: a per-file extraction failure for `AI_OUTPUT_INVALID`; invalid records go to review instead of failing the stage; unnamed records get no stable key; a bounded `P2034` retry for application transactions. |
| `backend/src/core/queues.ts` | Adds `knowledgeImport: 'knowledge-import'`. |
| `worker/src/processors.ts` | Registers the importer handlers on the new queue and on `imports` (to drain legacy jobs). Adds the queue to `FAIR_QUEUES`, with a 3-hour stage timeout. |
| `worker/src/main.ts` | Concurrency 2 for `knowledge-import`. |
| `package.json`, `package-lock.json` | `xlsx` moved to devDependencies (tests and scripts only). `jszip` 3.10.2 is now a runtime dependency. `mammoth` raised to ^1.13.0 for GHSA-rmjr-87wv-gf87. |
| `tests/integration/knowledge-import-resilience.test.ts` (new) | 6 tests: one-file failure isolation, invalid-record review, duplicate and re-upload rules, hostile files, sanitization and prompt injection, cross-tenant and role authorization. |
| `tests/helpers/env.ts` | Sets the test-safety environment so `npm test` runs without shell flags. |
| `tests/integration/knowledge-import-workflow.test.ts`, `tests/integration/knowledge-import-ai.test.ts`, `tests/unit/knowledge-import-extraction.test.ts` | Clear rate-limit state between runs, wait for queue events before adding jobs, use the new queue and the async template. |
| `e2e/knowledge-import.spec.ts` | New scenario covering cancellation, provider-outage failure, retry, skipping and cyclic reference editing. Adds a provider outage switch and badge locator, and clears `rl:*` rate-limit keys before each test. |
| `e2e/helpers.ts` | 60-second wait for the first workspace navigation; the dev server compiles that route on first visit. |
| `scripts/knowledge-import-recovery-smoke.ts` | Uses the new queue. Fixes a type error (`pending.isDelayed()`). Bounds worker close and teardown after a Redis restart, and exits explicitly. Records failure reasons and asserts no failed deliveries in the load scenario. |
| `frontend/app/w/[ws]/copilot/voice.tsx`, `frontend/components/ai/playbook-editor.tsx`, `frontend/components/ai/workflow-builder.tsx`, `frontend/app/w/[ws]/enrichment/batches/[id]/page.tsx`, `backend/src/services/verification-csv.ts`, `backend/src/routes/domains-enrichment.ts` | Lint warnings fixed at their source (section 13). |
| `docs/implementation/OUTREACH_BRAIN_IMPORTER_PROGRESS.md` | This report. |

## 3. Database migrations

No migration was added or edited in this release; `prisma/` is byte-identical to the previous tree. The importer's existing migrations are:

- `20261127120000_knowledge_importer`
- `20261127120200_business_knowledge_records`
- `20261127120300_icp_revisions`
- `20261127120500_knowledge_import_extraction`
- `20261127121000_knowledge_import_pipeline`
- `20261127122000_knowledge_import_integrity`

Migration safety was verified as follows.

- A fresh database (`outvexa_migration_verify`) took all 39 migrations plus `scripts/apply-sql.ts` through `npm run db:migrate`. `prisma migrate status` then reported "Database schema is up to date".
- `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma` reports 13 differences. All of them come from objects the Prisma schema file cannot express: three hand-written raw-SQL indexes (trigram and vector), database-side `gen_random_uuid()` defaults, and five long index names. No table or column is missing. These differences predate this release.
- `pg_dump -Fc` of the acceptance database (941,433 bytes) restored with `pg_restore` into `outvexa_restore_verify` in 2 seconds. Row counts matched exactly: 64 sessions, 80 files, 101 items, 57 knowledge documents, 56 revisions, 39 migration records and 384 indexes. `prisma migrate status` on the restored copy reported up to date.

## 4. Destination coverage matrix

| Entity (template sheet) | Application path | Evidence |
| --- | --- | --- |
| Company profile | Knowledge configuration version (`saveConfig`) | Browser and integration |
| Service | Native service draft and approval (`createService`) | Browser and integration |
| Commercial offer | Versioned offer in the knowledge configuration | Integration |
| Target audience | Versioned workspace knowledge record | Browser (both scenarios) and integration |
| Target persona | Versioned record with audience reference | Browser (cyclic scenario) and integration |
| ICP criteria | Native ICP revision (`saveIcpVersion`) | Integration |
| Business opportunity | Versioned workspace knowledge record | Integration |
| Competitor | Versioned workspace knowledge record | Browser (skip) and integration |
| Research rule | Versioned record and research configuration | Integration |
| Outreach rule | Native outreach rule (`createRule`) | Integration |
| Exclusion | Versioned record and eligibility check | Integration |
| Proof and case study | Unverified evidence record; native proof draft (`addProof`) when linked | Browser (reject) and integration |
| Campaign preference | Versioned campaign reference record | Integration |
| Instructions | Template guidance only; never imported | Unit (template content) |

The 14-sheet template (13 entity sheets plus Instructions) is downloaded and read back in the browser test. All 13 entity sheets are extracted and reviewed in the first browser scenario. Writes for each destination are real PostgreSQL writes through the native services, not representative stand-ins.

## 5. Real provider integration evidence

**None.** No authorized non-production OpenAI project API key and model ID were available in this environment. I did not invent one, bypass authentication, or treat synthetic responses as provider evidence.

`node --import tsx scripts/knowledge-import-provider-smoke.ts --provision-openai`, run against the acceptance database, stopped at its first check ("Set the smoke OpenAI project API key and model"). That is before it creates a workspace or makes any provider request. All extraction and embedding responses in sections 7–12 come from loopback fixtures at the provider HTTP boundary. Routing, prompt construction, response validation, repair, persistence and retry run in production code.

## 6. Provider and model configuration requirements

Run the live smoke against the isolated acceptance database only.

```bash
export DATABASE_URL=postgresql://emn:emn@127.0.0.1:5432/outvexa_knowledge_import_acceptance
export EMN_ENV_FILE=/dev/null
export KNOWLEDGE_IMPORT_SMOKE_OPENAI_KEY=<non-production OpenAI project key>   # from approved secret injection; never commit
export KNOWLEDGE_IMPORT_SMOKE_OPENAI_MODEL=<allowed model id>
node --import tsx scripts/knowledge-import-provider-smoke.ts --provision-openai
```

- The key must be allowed to list models and create inference requests. A valid application encryption keyring is required, because the key is stored through the existing encrypted provider service.
- The script creates a dedicated `Knowledge Import Provider Smoke` workspace and sets the extraction route. It checks the model list, then extracts small synthetic rows for every entity type. It reports coverage and usage metadata, checks that no provider content was retained, and writes no destination records.
- To use a workspace you configured yourself, set `KNOWLEDGE_IMPORT_SMOKE_WORKSPACE_ID` to a workspace named with the `Knowledge Import Provider Smoke` prefix that has an OPENAI API route.
- In production, configure the extraction route and encrypted credentials in AI Settings. Configure an embedding provider in the existing embedding settings if vector indexing is required; without one, documents are still stored and retrievable by text.
- On a private (single-tenant) instance, extraction can also run through the AI-source routing on a Claude subscription. That path is not offered to SaaS tenants, and it does not replace the OpenAI smoke above.

## 7. Worker termination recovery evidence

The harness is `scripts/knowledge-import-recovery-smoke.ts`. It starts a disposable loopback `redis-server` on a random port and runs child BullMQ workers against the isolated PostgreSQL database. Workers are killed with SIGKILL.

- **Default mode.** SIGKILL during `IMPORT_FILE_PARSE` both before and after the checkpoint commit: recovered, with 1 parsed file and 0 applied. SIGKILL after the approved-application commit and before the queue acknowledgement: recovered, with 1 revision, 1 application audit event, 0 unapproved items applied, and a final status of APPLIED.
- **`--stage-matrix` mode.** 22 scenarios, all passing in 102 seconds on the final run. Each ended APPLIED with exactly 1 revision, 1 vector and 1 application audit:
  - SIGKILL before and after the checkpoint for every stage from `IMPORT_EXTRACTION` through `IMPORT_RETRIEVAL_SYNC` (16 scenarios);
  - extraction: invalid output repaired; provider outage then recovery; result persisted before the crash;
  - embedding provider outage;
  - retrieval sync crash after acknowledgement;
  - Redis outage during an active retrieval sync (section 8).
- Production shutdown is bounded: the worker force-exits 60 seconds after SIGTERM if a graceful close stalls.

## 8. Redis outage and recovery evidence

- **Outage during submission.** Redis was killed while a worker was connected. A submission committed in 1,507 ms (the bounded 1.5-second publication). Redis restarted on the same port with an empty queue (persistence deliberately disabled to simulate queue loss). The worker reconnected after 3 connection errors, the reconciler recreated the missing job, and the session progressed.
- **Outage during active work.** The worker held the retrieval-sync job and the stage was active. Redis was killed and restarted inside an open application transaction. The session still reached APPLIED with exactly 1 revision, 1 vector and 1 audit.
- **Harness hang found and fixed.** After this scenario, BullMQ's graceful `close()` on a connection that had lived through the restart never resolved, and the harness hung. The harness now gives a graceful close 5 seconds, then a forced close another 2 seconds, then exits. Production is not affected, because of the 60-second force exit in section 7.
- Deployment Compose keeps AOF, a persistent volume and `noeviction`. Those settings make queue loss an edge case; the reconciler covers it.

## 9. Load-testing infrastructure and measurements

The test host was a Linux container: PostgreSQL 16 with pgvector, a loopback `redis-server`, and Node 22.

**Full pipeline (`--stage-matrix --load-only`).** 3 tenants made 6 submissions of 9 files: XLSX 76,350 bytes, DOCX 92,955 bytes and PDF 37,578 bytes, with re-imports deduplicated. Every file went through all 9 stages, approval, application, embedding and retrieval sync. The run made 618 provider-fixture requests.

| Metric | Before the P2034 fix | After (5 runs plus the matrix run) |
| --- | --- | --- |
| Failed deliveries | 1–3 per run | **0** in every run (now asserted) |
| Application queue wait (max) | 5,121–15,160 ms (BullMQ backoff) | 2–3 ms |
| Upload to review | 6.1–7.0 s | 5.9–7.1 s |
| Total elapsed | 11.4 s | 6.2–7.4 s |
| Peak RSS (harness and workers) | 434–454 MiB | 429–447 MiB |
| DB connections at end | 10 | 10 |

The total stage time on the final run is 2.1 s parse, 17.5 s extraction (3 jobs run concurrently), and under 0.5 s for every other stage. User CPU was about 6–7 s.

**Parser concurrency (default mode).** 4 tenants made 8 concurrent submissions of a 1,079,782-byte, 2,100-row workbook plus a TXT file. This produced 4 distinct sessions and 8 parsed files. Upload took 372 ms, the run took 1,033 ms, and peak RSS was 425 MiB.

**Defect found by load.** The importer previously shared the `imports` queue (concurrency 1) with lead CSV imports, so a long knowledge import could starve lead imports. It now has its own queue at concurrency 2. Its stage timeout is 3 hours (it was 30 minutes, which was too short for a subscription extracting 120 batches). The separation is verified in configuration. Lead-import progress during a knowledge import was not measured under load.

These are local baselines. Deployment capacity budgets were not available.

## 10. Security and tenant-isolation results

Results are from `tests/integration/knowledge-import-resilience.test.ts` and the existing workflow and retrieval suites.

- **Cross-tenant access.** Another workspace gets 404 on get, decide, apply, cancel, retry and bulk decisions. Retrieval from another workspace returns nothing.
- **Roles.** A viewer gets 403 on decide, apply and upload. Application rechecks administrator authority inside each transaction. Concurrent approvals serialize.
- **Hostile files.** A path-traversal file name is sanitized to `passwd.txt`. A PDF whose header doesn't match is rejected, as is a mismatched MIME type. A 90 MB DEFLATE bomb is rejected at the size limit.
- **Content.** HTML `<script>` and `onerror` are stripped. CSV formulas stay inert text. Prompt-injection text sends the record to NEEDS_REVIEW, and the prompt wraps source text as untrusted.
- **Dependencies.** `npm audit --omit=dev` reports 0 vulnerabilities, after removing SheetJS from runtime and upgrading mammoth.
- **Secrets.** No credentials were added to source, logs or reports. The queue error message stays sanitized, because provider errors can contain imported text.

## 11. Retrieval and downstream AI verification

- `tests/integration/knowledge-import-retrieval.test.ts`: a rejected persona never reaches retrieval or the AI prompt; another workspace retrieves nothing; ineligible destinations are filtered; trust classifications decide eligibility.
- First browser scenario: Copilot answers from the applied company profile, and its prompt does not contain the rejected, unverified proof claim. Research retrieval returns only the approved audience. The personalization snapshot contains the company description and never the unapproved claim.
- Retrieval after Redis recovery and after each worker kill is checked by the stage matrix, which expects exactly one vector per applied document.

## 12. Browser acceptance results

`npx playwright test --config playwright.knowledge-import.config.ts` runs real Chrome, the real API and Next.js UI, and a real BullMQ worker. It uses the isolated database and Redis DB 13. Both scenarios passed in four consecutive full runs, about 2.2 minutes each.

| # | Check from the brief | Where |
| --- | --- | --- |
| 1 | Template download | Both scenarios (14 sheets checked) |
| 2 | Multi-file upload | Scenario 1 (XLSX and DOCX) |
| 3 | Import progress | Scenario 2 (progress bar) |
| 4 | Parsing status | Scenario 2 ("Import File Parse") |
| 5 | AI extraction status | Scenario 2 ("Import Extraction") |
| 6 | Proposal list | Both |
| 7 | Provenance inspection | Scenario 1 (sheet, row, paragraph, excerpt, confidence) |
| 8 | Before/after comparison | Both (existing and proposed field table) |
| 9 | Proposal editing | Scenario 1 (fields); scenario 2 (references) |
| 10 | Approval | Both |
| 11 | Rejection | Scenario 1 |
| 12 | Skipping | Scenario 2 |
| 13 | Conflict resolution | Scenario 1 (approval enabled only after acknowledgement) |
| 14 | Cyclic reference editing | Scenario 2 (cycle returned with no destination writes, edited, then applied) |
| 15 | Application | Both |
| 16 | Application history | Both (audit history; native service version approval) |
| 17 | Failed imports | Scenario 2 (provider 503 on every attempt, session Failed) |
| 18 | Cancellation | Scenario 2 (cancelled at parse; the later job is a no-op) |
| 19 | Retry | Scenario 2 (retry after the provider recovers, reaching review) |

Re-import deduplication returns the same session, and a changed service surfaces as a conflict (scenario 1).

## 13. ESLint warning disposition

`npx eslint .` reports **0 errors and 12 warnings**. The rules were not changed and no warning was suppressed. Earlier lint fixes in the voice, playbook editor, workflow builder, enrichment batch, verification CSV and domains-enrichment files removed the others. They now use typed data, a ref for the latest dispose function, a memoized list and a value-based dependency.

All 12 warnings are `@typescript-eslint/no-explicit-any` and are intentional:

| Location | Reason |
| --- | --- |
| `backend/src/http/openapi.ts:17` (2) | `buildOpenApi(routes: RouteDef<any, any>[])` walks routes with different body and query schemas. |
| `backend/src/http/router.ts:56` (2) | `prepare?: (ctx: Ctx<any, any>)` on the registry type. |
| `backend/src/http/router.ts:64` (2) | `routes: RouteDef<any, any>[]` is the heterogeneous registry. |
| `backend/src/http/router.ts:72` (2) | `routes.push(def as RouteDef<any, any>)` erases a typed definition into the registry. |
| `backend/src/http/router.ts:201` (2) | Dispatch to `prepare`. |
| `backend/src/http/router.ts:215` (2) | Dispatch to `handler`. |

Each route is typed by its own Zod schemas at definition. Storing them together needs the erasure, and `unknown` would be rejected because the handler parameter is contravariant.

## 14. Build and type-check results

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm --prefix frontend run typecheck` (`tsc --noEmit`) | Passed |
| `npm run build` | Passed |
| `NEXT_DIST_DIR=.next-verify npx next build` (frontend) | Compiled successfully |
| `npx vitest run` | 61 files, 477 tests passed (final run after all fixes) |
| `npx eslint .` | 0 errors, 12 warnings (section 13) |
| `npm audit --omit=dev` | 0 vulnerabilities |

## 15. Exact commands executed

Environment for the recovery harness:

```bash
export DATABASE_URL=postgresql://emn:emn@127.0.0.1:5432/outvexa_knowledge_import_acceptance EMN_ENV_FILE=/dev/null LOG_LEVEL=silent
unset NODE_ENV OUTVEXA_WARMUP_TEST OUTVEXA_EMAIL_MODE DATABASE_MIGRATION_URL
```

| Command | Result |
| --- | --- |
| `node --import tsx scripts/knowledge-import-recovery-smoke.ts` | Passed (parse and application kills, Redis restart, parser concurrency) |
| `node --import tsx scripts/knowledge-import-recovery-smoke.ts --stage-matrix` | Passed (22 scenarios plus full-pipeline load) |
| `node --import tsx scripts/knowledge-import-recovery-smoke.ts --stage-matrix --sync-only` | Passed |
| `node --import tsx scripts/knowledge-import-recovery-smoke.ts --stage-matrix --load-only` (×5 after the fix) | Passed, 0 failed deliveries |
| `CHROME_PATH=/usr/bin/google-chrome npx playwright test --config playwright.knowledge-import.config.ts` | 2 passed (×4) |
| `npx vitest run` | 477 passed |
| `npm run typecheck`, `npm --prefix frontend run typecheck`, `npm run build`, frontend `next build`, `npx eslint .`, `npm audit --omit=dev` | See section 14 |
| `npm run db:migrate` and `npx prisma migrate status` on `outvexa_migration_verify` | 39 migrations plus raw SQL applied; up to date |
| `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | Pre-existing non-functional differences only (section 3) |
| `pg_dump -Fc` / `pg_restore --no-owner` into `outvexa_restore_verify`, then `prisma migrate status` | Identical counts; up to date |
| `node --import tsx scripts/knowledge-import-provider-smoke.ts --provision-openai` | Stopped before any provider call: no key or model |

## 16. Deployment requirements

1. Run `npm install` at the repository root and in `frontend/`, because of the dependency changes. There are no schema changes; run `npm run db:migrate` as usual with an owner-capable migration account. PostgreSQL needs the `vector`, `pg_trgm` and `unaccent` extensions.
2. Deploy the API, frontend and worker from the same revision. The worker must consume the new `knowledge-import` queue (concurrency 2). It also keeps draining importer jobs left on the legacy `imports` queue; once that queue holds no `IMPORT_*` jobs, that registration can be retired in a later release. The maintenance worker must run, because the reconciler republishes deferred jobs.
3. Keep Redis AOF, the persistent volume and `noeviction`. Allow at least 60 seconds for worker shutdown (SIGTERM, then force exit).
4. The proxy must allow multipart requests of 40 MB of file data plus framing.
5. Configure the workspace extraction route and encrypted credentials. Configure the embedding provider if vectors are wanted. Run the provider smoke in section 6 before opening uploads.
6. Monitoring: watch `knowledge-import` queue age and failures in Platform Operations, Redis reconnect errors, and "deferred publication" log lines (they carry workspace, session, stage and run only). Also watch for sessions whose `processingStep` and `run` stay unchanged, and for `P2034` retries. To investigate a stalled import, match session ID, stage and run between PostgreSQL and the queue job ID `knowledge-import-<session>-<run>-<stage>`.
7. Rollback: stop new uploads, let application transactions settle, then roll back the API and worker together. Preserve the Redis volume and committed checkpoints. An older worker only reads the `imports` queue, so drain or re-enqueue `knowledge-import` jobs before downgrading.

## 17. Remaining limitations

- **External prerequisite.** Live provider extraction has not been verified: attribution, usage and cost, repair against real model output, real timeouts and rate limits, and fallback. This needs the non-production OpenAI key and model in section 6.
- The HTTP 503 path for upload admission when Redis is unavailable is covered by code review and type checks, not by fault injection through HTTP. Service-level submission during the outage was exercised.
- Lead-import progress while a knowledge import runs is guaranteed by the queue separation, but was not measured under load.
- Load figures are a single-host baseline, not a production capacity statement.
- Cycles always need an administrator to edit references. The importer never creates mutually dependent records automatically. Similarity suggestions never merge records.

**CONDITIONALLY READY**

## 18. Expanded AI Outreach Brain and ICP workbook coverage

The v3 workbook retains v1 and v2 import compatibility. It adds worksheets for Products, Research Settings, Writing Settings, Prompt Profiles, Training Examples, and Achievements. The importer now writes these through the existing Business Knowledge, versioned workspace configuration, prompt profile, and outreach training services. Review and application authorization remain in the existing pipeline.

| Destination | Expanded fields and application behavior |
| --- | --- |
| Company profile | Native target audience, customer profiles, and pricing notes |
| Products | Name, description and stable workbook identifier in versioned Business Knowledge |
| Services | Employee ranges, included/excluded industries and geographies, structured exclusion rules, methodology, availability, and evidence notes. Partial updates retain omitted terms and still create drafts. |
| ICP | Titles, seniorities, industries, countries, employee bounds, keywords, instructions, active status, criteria, and threshold. Omitted fields carry forward to the next revision. |
| Writing settings | Tone, length, language, CTA, style, complexity, intensity, formality, examples, restrictions, and instructions |
| Research settings | Topics, signals, source toggles, evidence windows, minimum claims, search budgets, missing-evidence behavior, and instructions |
| Outreach rules | Native category, priority, condition, active state, and trigger terms |
| Prompt profiles | Instructions and writing overrides, with immutable versions |
| Training examples | Content and correction, category, polarity, explanation, tags, active state, and reviewer attribution |
| Achievements and case studies | Visible in Business Knowledge as unverified evidence. Existing native evidence is preserved. Import approval alone does not verify claims. |
| Competitors | Approved explicit facts can populate Business Knowledge alongside the existing structured competitor record. Existing native entries are preserved. |

For recognized worksheets that produce structured proposals, explicit workbook cells for native controls take precedence over AI paraphrases. The destination schema validates the resulting record. Operational settings, provider credentials, and campaign activation stay in their existing administrative workflows.

No migration was needed. Existing JSON configuration versioning and the current ICP schema carry the new fields.

- The focused five-file Vitest suite in section 15 passed **34 tests** on the isolated PostgreSQL database with Redis DB 12.
- The expanded Chrome workflow downloaded v3, extracted all worksheets, approved nine proposals including products, writing, research, ICP, prompt profiles, and training examples, and verified application, retrieval, and identical re-import. The separate cancellation, retry, and cycle-resolution workflow also passed.
- Backend and frontend type checks and production builds, repository ESLint, and `git diff --check` were rerun. The release provider prerequisite in section 6 remains open.

**CONDITIONALLY READY**
