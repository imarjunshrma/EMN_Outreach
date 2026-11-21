# Security and tenant boundaries

- Every new read/write uses the authenticated workspace ID; child records are verified against that workspace before update/delete/feedback.
- Read endpoints allow workspace VIEWER; rule/example/suggestion mutations require ADMIN. Existing personalization edit roles and approved-content checks apply.
- Examples are tenant-scoped, bounded in size/count, selected from a frozen workspace snapshot, and wrapped as untrusted content.
- Model-returned claim IDs and opportunity-analysis IDs are constrained to evidence supplied for that lead. No-claim analysis is forced to insufficient information.
- Trigger terms apply only to active AVOID/MANDATORY rules and create deterministic failed quality checks.
- Learning candidates require global scope and repeated edits; admins must approve them before a rule is created.
- Migration includes workspace and personalization foreign keys. Cross-tenant integration tests and runtime database-role verification remain pending until isolated PostgreSQL is available.

Do not put secrets, credentials or unnecessary personal data in rules, examples or feedback notes.
