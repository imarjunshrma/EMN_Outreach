# Generation pipeline

1. Load the campaign's frozen AI snapshot when available; otherwise resolve current workspace config.
2. Resolve knowledge, writing/research configuration, profile, campaign, ICP, sequence step, variant and lead instructions.
3. Load evidence-backed claims. Build a relevance context and select no more than three positive and two negative active examples from the snapshot.
4. Add active rules, examples, evidence and the evidence-linked opportunity-analysis instruction to the existing personalization prompt. Example text is wrapped in untrusted-content tags.
5. Call the configured AI adapter, parse its structured output, discard unsupported claim IDs, and sanitize opportunity analysis against supplied evidence IDs.
6. Run independent fact checking, deterministic quality checks, and configured active AVOID/MANDATORY trigger-term checks. Failing checks block approval.
7. Save draft, score explanation, opportunity analysis and immutable revision. Existing approval/hash/send controls remain in effect.

Retrieval is lexical and bounded, not embedding or semantic search. Opportunity qualification is model-assisted and is not a validated sales prediction.
