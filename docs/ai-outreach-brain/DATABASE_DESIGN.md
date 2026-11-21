# Database design

All new tables are workspace-scoped and use UUID identifiers. Migration: `prisma/migrations/20261121190000_ai_outreach_brain/migration.sql`.

- `OutreachRule`: title, description, category, priority, optional condition, active state, deterministic trigger terms, creator and timestamps. Rules are configuration, never system prompt overrides.
- `OutreachExample`: named text example, optional corrected text/explanation, category, positive/negative polarity, tags and active state. Examples are retrieved in a bounded subset and treated as untrusted input.
- `OutreachFeedback`: personalization foreign key, type, original/final JSON content, changed fields, scope and optional explanation. Its scope defaults to campaign-specific.
- `AiLearningSuggestion`: stable workspace/signature uniqueness, heuristic evidence/sample count/confidence and pending/accepted/rejected status.

Foreign keys cascade with workspace or personalization deletion. No provider credentials are stored here. Existing frozen campaign snapshots preserve reproducibility; pre-feature snapshots are read with empty rule/example defaults.

Fresh database migration and owner/runtime-role grants still require PostgreSQL and are not verified in this environment.
