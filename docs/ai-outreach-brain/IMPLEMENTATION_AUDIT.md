# AI Outreach Brain — implementation audit

Audit date: 2026-11-21. This document reflects the repository, not the older feature inventory.

## Existing architecture and reusable components

- Frontend: Next.js App Router in `frontend/app/w/[ws]`; workspace navigation is role-filtered in `frontend/components/shell/nav.tsx`.
- Backend: Express API route registry in `backend/src/http/router.ts`; validated routes in `backend/src/routes`; service layer in `backend/src/services`.
- Persistence: PostgreSQL + Prisma in `prisma/schema.prisma`; every relevant AI table is workspace-scoped.
- Existing AI configuration: `AiConfigVersion` stores immutable workspace versions for KNOWLEDGE, WRITING, and RESEARCH. `KnowledgeDocument` stores tenant-scoped text references. `PromptProfile` and `PromptProfileVersion` support campaign-specific prompt instructions and frozen versions. Code: `shared/src/ai-studio.ts`, `backend/src/services/ai-studio.ts`, `backend/src/routes/ai-studio.ts`.
- Provider abstraction: `integrations/src/ai/types.ts`, adapters in `integrations/src/ai`, registry/composition in `backend/src/core/container.ts`, routing/budgets/usage in `backend/src/services/ai.ts`. OpenAI, Anthropic, Gemini, OpenAI-compatible cloud providers and Ollama-compatible endpoints are represented. Live credentials are not present in this audit environment.
- Research/evidence: `backend/src/services/intelligence.ts` uses configured licensed/search providers and a safe public-page fetcher; `ResearchReport`, `ResearchEvidence`, and `ResearchClaim` retain source URLs, quotes, confidence and timestamps. Unsupported claims are filtered before use.
- Personalization/campaign: `backend/src/services/personalization.ts` resolves workspace → profile → campaign → ICP → step → variant → prospect instructions, uses approved research claims, fact-checks, runs deterministic checks, stores revisions, and preserves approved/manual content. `PersonalizationBatch` and BullMQ workers provide queued batch generation, cancellation, retry and cost limits. Existing send safety requires approved content/hash for pre-generated personalization.
- Tenancy/security: workspace authorization is resolved server-side; AI data services scope queries by workspace. Existing integration coverage includes personalization and multi-tenant boundaries.
- Tests: Vitest unit/integration suites, fake AI/mail/provider adapters and Playwright E2E config exist. Integration tests require the configured PostgreSQL/Redis environment; fakes are not live provider verification.

## Gaps addressed in this implementation

- Explicit categorized/prioritized outreach rules with conditional descriptions and conflict warnings.
- Positive/negative text examples retrieved by workspace-scoped lexical relevance rather than sending all examples to every prompt.
- Structured opportunity and qualification analysis attached to personalization output, constrained to evidence claim IDs and marked as fact/inference/unknown.
- Feedback records for edits, approvals and rejections; repeated deterministic edit patterns can create opt-in learning suggestions.
- Human-facing training page and APIs integrated into AI Studio.

## Remaining gaps / limits

- The product continues to use its existing text generation path; no image, audio or embedding workflow is introduced.
- Research coverage is limited to configured providers and public sources allowed by the existing fetcher. LinkedIn/private pages remain excluded.
- Model behavior and current provider availability require live keys for actual compatibility checks.
- No anonymized, human-approved 50-scenario benchmark corpus exists in the repository. Synthetic tests are not represented as a human-quality benchmark.
- Organization-level inheritance is not implemented for the existing AI Studio; training data remains workspace-specific.
- Secure document upload already exists for knowledge documents. Examples added here are text-only; file ingestion is not duplicated.

## Data/API changes

Workspace-scoped models: `OutreachRule`, `OutreachExample`, `OutreachFeedback`, and `AiLearningSuggestion`. Existing `LeadPersonalization` and `PersonalizationRevision` remain the source for generated content and immutable revision history. API additions cover CRUD, feedback/suggestions and conflict preview. Generation receives only a small relevant subset of active examples/rules.

## Security considerations

All new service reads and writes include the authenticated workspace ID. Examples are treated as untrusted content and wrapped before prompt inclusion. Rule text is configuration, validated and size-limited; it cannot alter platform system safety requirements. Feedback contains generated email text and is subject to existing workspace retention and authorization. No credentials or raw provider keys are stored in the new models.

## Implementation sequence

1. Add tenant-scoped models and migration.
2. Add rule/example/feedback service logic and authenticated routes.
3. Add an AI Training UI under the existing AI Studio.
4. Retrieve rules and a bounded set of relevant examples in existing personalization context.
5. Add evidence-linked opportunity analysis to the existing structured generation result.
6. Capture edit/approval/rejection feedback and generate suggestions only after repeated patterns.
7. Add unit/integration coverage and accurate deployment/status documentation.
