# 17 — Source-code audit of v1.1.0 (performed before v1.2 work)

This audit covers 1.1.0 as shipped. I traced code paths and ran the tests; where a fix was made, its evidence is the test listed.

## 1. AI Personalization Studio: claimed vs actual
The **Status** column records what was found in 1.1.0, before any fixes.

| Feature | Database | Backend | Worker | Frontend | Status |
|---|---|---|---|---|---|
| Versioned knowledge, writing and research config | `AiConfigVersion` | `ai-studio.ts` get/save/activate | — | `/ai-studio/{knowledge,writing,research}` | ✅ verified |
| Knowledge documents | `KnowledgeDocument` | create/update/delete; text extraction for txt/md/csv/json/html | — | knowledge page | ✅. PDF/DOCX are not parsed, and the docs say so |
| Prompt profiles: versions, compare, folders/tags, approve, import/export, test | `PromptProfile(+Version)` | `ai-studio.ts` | — | `/ai-studio/profiles[/id]` | ✅ |
| Instruction hierarchy incl. prospect level | `Lead.aiInstructions`, `Step/Variant.aiInstructions`, `Campaign.aiOverrides` | `resolveConfig` + `resolveFromSnapshot` | — | campaign AI tab, step editor, review modal | ✅. Verified by tests 2+3 |
| Per-lead generation, fact-check, quality checks, score, revisions | `LeadPersonalization`, `PersonalizationRevision` | `personalization.ts` | `personalize.lead` / `personalize.single` | review modal | ✅ |
| Bulk + estimate + cost cap + cancel + retry | `PersonalizationBatch` | ✓ | ✓ | Generation card | ✅ |
| Approval snapshot + sequence versions | `Campaign.aiConfigSnapshot`, `SequenceVersion` | `approveCampaign` | — | Versions tab | ✅. Verified by test 8 |
| Send only approved content | — | `prepareOutbound` | prepare/send | — | ✅. Verified by test 9 |

## 2. Defects found and fixed in this audit
| # | Finding | Severity | Fix | Evidence |
|---|---|---|---|---|
| A1 | The SMTP adapter passed SMTP reply codes through as HTTP-style statuses. A permanent `550` was treated as transient (retried and reconciled), a temporary `450/451` failed permanently, and an auth failure (`535`) did not trigger re-authentication | **High** (wrong failure semantics for every SMTP mailbox) | `smtpError()` maps codes as follows: auth→401, 5xx→400 (permanent), 4xx→503 (retryable), no code→ambiguous | `tests/unit/smtp-protocol.test.ts`, which runs a real SMTP session against an in-process `smtp-server` |
| A2 | Batch worker: if another job held the per-lead lock, the result `GENERATING` was counted as "done" | Medium (wrong batch counters) | Throw so BullMQ retries | Code path; regression suite |
| A3 | Re-running the fact-check after a manual edit ignored the per-lead cost limit | Low | Passes `maxLeadCostUsd` | Code path |
| A4 | After a FAILED generation, the `personalize.single` job id could collide with an earlier failed job in BullMQ's failed set, so it was never retried automatically | Low (manual "retry failed" still worked) | Job id now includes an hourly bucket | Code path |
| A5 | The SMTP adapter had no tests at all | Medium (coverage gap) | Real-protocol SMTP tests added | As A1 |

## 3. Isolation, permissions, snapshots, versioning, cost limits, idempotency
- **Tenant isolation.** Every new personalization or AI Studio query was traced and filters by `workspaceId`, including ids taken from the request body (campaign→step, lead, profile, ICP). Tested over the API by `isolates personalization data between workspaces`.
- **Permissions.**
  - Approving personalizations, bulk generation, cancelling a batch and restoring a version require MANAGER.
  - Changing AI Studio config or documents requires ADMIN.
  - Profile edits, generation, preview and test email require MEMBER.
  - Approving a profile for team use is limited to MANAGER and above.
- **Snapshots.** The approved campaign keeps generating from its snapshot (test 8). The campaign hash covers step and variant instructions, AI overrides, profile id, cost limit and scheduled start.
- **Cost limits.**
  - Before each personalization or fact-check call: per-lead spend plus an upper-bound estimate is checked.
  - Workspace monthly budget and per-task budget are enforced; reply classification is exempt so opt-outs are never missed.
  - Batch cost cap.
  - Evidence: test 10.
- **Send idempotency.** Guaranteed by the unique (enrollment, step) row, the atomic QUEUED→SENDING claim, reconciliation, and the SMTP fail-safe. Evidence: test 9 and the engine suite.

## 4. Mail adapters: readiness for live integration
| Adapter | Implemented against the official API | What is missing | Verified live? |
|---|---|---|---|
| Gmail | OAuth + PKCE, token refresh/revoke, raw MIME send keeping threadId, history-based sync with full resync fallback, raw fetch with attachments parsed, Sent search by `X-EMN-Outbound-Id` | Pub/Sub push (polling every 2 min), drafts, labels, forwarding | **No.** Tests mock HTTP shapes. Needs a Google Cloud OAuth client and a test mailbox |
| Microsoft Graph | OAuth + PKCE, MIME `sendMail`, delta sync of Inbox and Sent, change-notification subscribe/renew/unsubscribe | Graph has no per-token revoke; disconnecting deletes tokens and subscriptions. No drafts or forwarding | **No.** Needs an Entra app and a test tenant |
| SMTP | nodemailer send with raw MIME, connection test, code mapping (A1) | — | Protocol verified against a real SMTP server in-process. **No real provider tested** |
| IMAP | imapflow UID-based sync per folder with UIDVALIDITY, append to Sent, search by header | No IDLE (polling) | **No.** No IMAP server is available in the build environment |

## 5. Docker and S3
- **Docker.** `docker compose config` validates. The images were **never built** because Docker Hub is blocked here.
  - The API image includes dev dependencies, so migrations can run through `tsx`. This works but makes the image larger; it is documented.
  - The `api` service sets `API_HOST=0.0.0.0` (added in 1.1). Its ports are published only on 127.0.0.1.
- **S3.** The adapter covers put/get/stream/delete/exists/signedUrl and has a unit test with a mocked client. It has **not been run against a real bucket**. Signed URLs exist in the adapter but are not yet used by download routes, which stream through the API; that remains correct with S3.

## 6. Documentation vs code
- Ledger and doc 15 claims match the code. Two corrections are made in 1.2: the SMTP failure semantics (A1), and adapter coverage, which in 1.1 was described as "mocked HTTP" for Gmail/Graph without mentioning that SMTP was untested.
- `README` "What needs real credentials" remains accurate.
