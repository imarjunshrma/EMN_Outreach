# AI Outreach Brain architecture

The feature extends the existing AI Studio and personalization path. It does not create a second generator.

1. Workspace admins maintain categorized rules and positive/negative examples in the Training page.
2. Campaign approval freezes the current AI Studio configuration, rules, and examples in the existing campaign AI snapshot.
3. `buildContext` resolves that snapshot, retrieves at most three positive and two negative examples with a deterministic lexical score, wraps example text as untrusted data, and includes active rules.
4. The existing provider router generates structured email and opportunity analysis. Evidence IDs are filtered against supplied claims; deterministic quality checks and configured rule trigger terms can block drafts.
5. People edit, approve, or reject drafts. Feedback is stored with scope. Only explicitly global edits are eligible for heuristic learning suggestions. Admins must accept each suggestion to create a rule.

Main components: `frontend/app/w/[ws]/ai-studio/training/page.tsx`, `backend/src/routes/ai-studio.ts`, `backend/src/services/outreach-brain.ts`, `backend/src/services/ai-studio.ts`, `backend/src/services/personalization.ts`, and `shared/src/outreach-brain.ts`.

Provider calls continue through the existing adapter registry. This implementation adds no provider dependency and makes no live-provider compatibility claim.
