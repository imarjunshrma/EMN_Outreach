# Isolated browser E2E

## Start the fixture

Run these commands from the repository root. The setup requires the local PostgreSQL administrator, the repository dependencies, and Redis executables. It provisions only the loopback `outvexa_browser_e2e` database and role and a dedicated Redis process on port 6387. It never drops or resets a database. A repeated run refreshes the fixture user's password hash and workspace safety settings while keeping draft edits.

```sh
bash scripts/setup-browser-e2e.sh
node scripts/browser-e2e-env.mjs node --import tsx backend/src/main.ts
node scripts/browser-e2e-env.mjs npm --prefix frontend run dev -- --hostname 127.0.0.1 --port 3128
```

Start the API and frontend in separate terminals. Open http://127.0.0.1:3128/login and sign in as `owner@elite-media.e2e.test` using the generated fixture password in `/private/tmp/outvexa-browser-e2e/fixture-password`. This is an ordinary owner login through the real UI. Sign out between runs to invalidate the browser session.

The fixture includes an offline mailbox with no provider credentials and the campaign `E2E TEST — EMN — DRAFT ONLY`. To clean up a new or modified fixture draft, use Campaigns → Delete, then rerun setup to recreate a missing baseline draft. Stop the two fixture servers from their own terminals and use `redis-cli -h 127.0.0.1 -p 6387 shutdown nosave` to stop the dedicated Redis process after checking its PID against the fixture's Redis PID file.

## Delivery boundary

- Startup validates an exact database, role, Redis endpoint, queue prefix, storage root, loopback API bind, mock transport and disabled SMTP verification. The fixture launcher passes an allowlist of environment values and skips the repository's `.env`. API startup rejects a connected mailbox or stored mailbox credentials.
- Campaign activation, scheduler dispatch, warm-up lifecycle and execution, direct sends, mailbox connection, and export to a live Smartlead campaign are blocked. The fixture mock records send attempts and rejects the operation. Real Gmail, Graph, SMTP/IMAP and their OAuth client constructors reject the fixture process.
- Queue producers and dispatchers block delivery and scheduler queues. The regular full worker refuses to start. Draft operations which depend on a background worker need a separately scoped fixture worker. This setup contains no external AI, email, or discovery credentials.
- Blocked actions append an operation and timestamp to `blocked-delivery.jsonl` in the fixture storage root. The file excludes recipient addresses and message content.

## Verification on November 28, 2026

| Check | Status | Evidence |
| --- | --- | --- |
| Provisions isolated PostgreSQL and Redis | PASS | Migrations applied to `outvexa_browser_e2e`; a second setup reused the fixture with no pending migrations. |
| Login, workspace selection, logout | PASS | Chrome logged in via the form, opened Elite Media Networks E2E from the workspace picker, signed out, and was redirected when reopening Campaigns. |
| Campaign controls and persistence | PASS | Changed the fixture draft to Gradual ramp-up using the UI's defaults, saved it, navigated away, and reopened it as DRAFT with GRADUAL selected. |
| Prospect and mailbox pages | PASS | Prospect Discovery showed its unconfigured state. Mailboxes displayed the seeded offline account. |
| Copilot availability | PASS | Copilot loaded and displayed the prompt control. AI response generation was not tested. |
| Workspace events | PASS | The authenticated EventSource opened and returned 200. After sign-out it returned 404, matching the membership gate's behavior for unauthenticated requests. |
| Campaign activation and warm-up | PASS | Authenticated negative requests with valid payloads got 403 and `E2E_DELIVERY_BLOCKED`. |
| Queue publication, queue processing, mock send and real constructor | PASS | The server-side safety check rejected each operation. No outbound queue keys or messages were created. |
| Unsafe startup | PASS | Starting the API with the mock flag removed and launching the full worker both exited nonzero. |
| AI research, verification, generation and delivery | NOT TESTED | The fixture does not configure external providers. No delivery was attempted beyond the intentional blocked negative tests. |

The browser workflow recorded zero page errors or failed HTTP responses during its positive navigation and settings checks. A React hydration warning appeared on sign-in after logout. It reported a style-attribute mismatch. Negative tests also recorded expected 403s and a 400 for an initial malformed warm-up request. The corrected warm-up request reached the safety boundary.

Artifacts are under `/private/tmp/outvexa-browser-e2e`. The trace contains authenticated fixture requests and is for local use.

Commands executed included `bash scripts/setup-browser-e2e.sh`, `node scripts/browser-e2e-env.mjs node --import tsx scripts/check-browser-e2e-safety.ts`, `SKIP_TEST_DB=1 npm test -- tests/unit/warmup-test-safety.test.ts`, `npm run typecheck`, `npm run build`, focused ESLint, and `git diff --check`. All passed. The final isolated database had zero provider credentials, outbound messages, warm-up programs or warm-up messages. The fixture mailbox had no last-send timestamp.

## Draft workflow run on November 28, 2026

Run the allowlisted worker in a separate terminal under the same profile.

```sh
node scripts/browser-e2e-env.mjs node --import tsx worker/src/browser-e2e.ts
```

The worker registers no schedules. It consumes only CSV import, prospect/company research, ICP scoring and campaign personalization jobs. It rejects unlisted job names even when they arrive in an allowed queue. It applies the shared job processor and records attempts and results in `draft-jobs.jsonl`. The provider composition uses the local AI fixture and serves two synthetic company homepages from memory. `mock-ai.jsonl` records the routed provider label and model and the actual fixture model. The fixture currently implements fact extraction, qualification and the two Copilot test prompts. Other model tasks fail explicitly. A separately approved external AI run is still unconfigured.

The authenticated Chrome run used the Elite Media Networks E2E workspace at `http://127.0.0.1:3128/w/bf7463b5-55fb-4156-a8d6-807cb17b239c`. Routes below are relative to that workspace. API paths are relative to its `/api/v1/w/{workspaceId}` prefix.

| Feature | Status | Browser, API and persisted evidence |
| --- | --- | --- |
| Login, Discovery and CSV import | PASS | Normal owner sign-in. Opened `/prospecting` and `/leads/import?destination=new`, mapped a three-row CSV and saved a new list. `POST /imports` returned 201 and start returned 202. `import.csv` completed with 2 imported, 1 duplicate skipped and 0 errors. Both names appeared in Leads. |
| Research and claim review | PASS | Bulk research from `/leads` returned 200. Both initial jobs and Ava's subsequent deep research completed. Opened `/research/{reportId}`, inspected the source URLs and verbatim excerpts, and marked the initial claims supported through four successful PATCH requests. Fresh claims first appeared as Needs Review. |
| ICP scoring | PARTIAL | Created an ICP from `/icps` with Founder and US criteria (201). Bulk scoring returned 200. After reviewing evidence, the worker persisted Ava at 85 with a qualified result and Noah at 15 with a rejected result. Ava's lead-level status remained DISQUALIFIED after the rescore. The scoring service only updates that status for NEW and RESEARCHED records. |
| Verification and audience eligibility | BLOCKED | Verify email returned 403 from `/leads/{id}/verify-waterfall`. Both leads stayed UNVERIFIED. No prospects were attached to the campaign. Suppression and invalid-address exclusion were not exercised. |
| Personalized email, preview, edit and reopen | BLOCKED | The campaign's AI personalization tab displayed zero approved service versions and no generated content. The fixture also lacks deterministic personalization and fact-check outputs. The database contained zero personalization rows. There are no generated drafts to evaluate. |
| Campaign settings and mailbox | PASS | Saved campaign limit 30, America/New_York and Gradual maximum 20 in Settings & schedule (PATCH 200). Persisted window remained Mon–Fri 09:00–17:00, with no scheduled start. Changed the disconnected mailbox's gaps to 90–180 seconds from `/email-accounts` (PATCH 200), preserving the 20/day mailbox limit. |
| Ramp-up and shared mailbox | PARTIAL | Reopened the campaign in Chrome and independently read the policy from PostgreSQL. The production target calculation was exercised for seven calendar days with hypothetical healthy samples. The real fixture mailbox policy returned a domain-authentication hold on each date. Shared allocation across two running campaigns was not exercised. |
| Follow-up configuration | PASS | Added step 5 in Sequence builder and saved. The sequence PUT returned 200 and persisted the four-day delay. |
| Reply, unsubscribe and bounce handling | NOT TESTED | No synthetic reply or delivery events were injected. Positive/negative classification and follow-up stopping remain unverified. |
| Copilot | PASS | Two `POST /copilot/ask` responses returned 200. A read-only question displayed the fixture workspace answer. A second prompt proposed a campaign draft. After explicit confirmation, execution returned 200 and PostgreSQL showed `Copilot E2E draft` in DRAFT. Voice and personalized email generation were not exercised. |
| Analytics | PARTIAL | Opened `/analytics`. Overview, daily, monthly, campaigns and mailboxes returned 200. The isolated database had zero email events. Metric attribution with synthetic events was not exercised. |

### Seven calendar days using the persisted policy

One accepted submission on an eligible day qualifies that day in the healthy scenario. Every three qualifying days increase the following target by one. The dates below assume a healthy sample on each of the five weekdays. With health evidence that holds progression the policy target stays at one. The offline fixture had zero effective capacity for all seven dates.

| Local date | Sending day | Healthy target | Effective fixture capacity |
| --- | --- | --- | --- |
| Nov 30 | Mon | 1 | 0 |
| Dec 1 | Tue | 1 | 0 |
| Dec 2 | Wed | 1 | 0 |
| Dec 3 | Thu | 2 | 0 |
| Dec 4 | Fri | 2 | 0 |
| Dec 5 | Sat | Window closed | 0 |
| Dec 6 | Sun | Window closed | 0 |

### Model routing and evidence

The AI settings page showed no workspace default selected and the only configured provider was OpenAI with `outvexa-e2e-fixture-v1`. Research, qualification and Copilot resolved to that provider label and model. Actual execution used the local mock model of the same name. Personalization, email writing and fact checking did not execute. The reported Grok selection was not reproduced with this fixture. Source inspection shows that a task using an explicit route can select a different model from the workspace default, and the configured fallback can also affect execution. That is a possible route to the reported behavior, not a diagnosis.

The synthetic sources were `https://signalwork.example/` and `https://ledgerfield.example/`. Signalwork's fixture identifies Ava as founder and says it publishes a weekly podcast for consulting businesses. Ledgerfield's fixture identifies Noah as finance director and describes its accounting software for regional retailers. The stored claims cite these excerpts. No claim was evaluated inside a generated email.

The E2E safety check passed again after the run. Both campaigns were DRAFT. The isolated database had zero outbound records, email events, warm-up programs, warm-up messages and provider credentials. The mailbox had no last-send timestamp. Redis contained no delivery or warm-up queue keys. Commands and browser traffic were scoped to the isolated profile. No write targeted `emn_dev` and no Firebase configuration or commits were made.

Files changed for this run were `worker/src/browser-e2e.ts`, `backend/src/core/browser-e2e-ai.ts`, `backend/src/core/container.ts`, `scripts/seed-browser-e2e.ts` and this report. Browser artifacts, HTTP status log, database checks, ramp-up output and job logs are under `/private/tmp/outvexa-browser-e2e`. The trace includes authenticated fixture HTTP data and is for local use.
