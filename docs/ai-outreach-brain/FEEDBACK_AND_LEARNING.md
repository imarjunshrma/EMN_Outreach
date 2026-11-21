# Feedback and learning

Edits, approvals and rejections are recorded against a workspace personalization. Edits store original generated content, final edited content, changed fields, actor, scope and optional note. Manual edits remain in the existing revision history.

Only `GLOBAL` edits are examined by the current deterministic heuristics. A candidate must match at least three edits for generic openings, substantially shortened drafts, or removed early meeting requests. Confidence/sample count are heuristic summaries, not statistical validation. Evidence contains changed-field names rather than email text. Suggestions remain pending until an ADMIN accepts or rejects them. Acceptance creates a workspace rule; no model retraining or silent prompt modification occurs.

Feedback can contain email text and should follow workspace retention/access policies. Do not mark a preference global merely to improve a single draft.
