# Email quality evaluation

This benchmark is separate from the 72-case qualification/decision benchmark. It contains 36 synthetic prospect contexts (18 tuning, 18 held out) and no generated emails or auto-approved examples.

## What it measures

Independent reviewers score each generated email from 0 to 5 on research accuracy, identity correctness, opportunity relevance, approved-service match, opening specificity, natural language, business relevance, and CTA relevance. They also label whether the email contains an unsupported claim, is generic, and requires human correction. Accuracy and identity ratings must be based on the supplied evidence and prospect fields; service match must use only supplied approved service IDs. A score of 0 means materially incorrect/unsafe, 3 means acceptable with noticeable weaknesses, and 5 means strong and evidence-backed.

Reviewers should rate blindly where practical, use the same annotation guide, and resolve disagreements before reporting a model comparison. The runner computes dimension means, an equal-weight normalized composite, unsupported-claim rate, generic-content rate, and human-correction rate. These are reviewer labels, not an LLM-as-judge result.

## Fair comparison

Run every model/prompt variant against every case in exactly one partition. The SHA-256 fingerprint is computed from the dataset input and must match each annotation. The runner rejects missing or extra cases, duplicated variant/case pairs, wrong fingerprints, and annotations from the other partition. Use `tuning` only while revising prompts. Do not tune against `held_out`; reserve it for a final comparison and report the variant IDs, prompt versions, model/provider, date, evaluator and any adjudication.

## Annotation file

Export a partition with `npm run eval:email-quality -- --export /tmp/email-quality-held-out.json --partition held_out`. Use those exported cases (including `inputFingerprint`) to run each provider/model/prompt variant. Have reviewers prepare a JSON annotation array where each row has `caseId`, the unchanged dataset-derived `inputFingerprint`, `variantId` (include prompt version), `email`, a `scores` object with the eight rubric fields as integer 0–5, and booleans `unsupportedClaim`, `genericContent`, `humanCorrectionRequired`. Score it with `npm run eval:email-quality -- --annotations /tmp/email-quality-annotations.json --partition held_out`.

The runner does not invoke a model, send mail, modify CRM data, or approve the emails. Keep prospect data synthetic or appropriately de-identified. Do not put real contact details, secrets, or provider keys in benchmark files.

## Limitations

The current benchmark is synthetic and reviewer-driven. It does not establish live campaign quality or statistical generalization. Its scoring is descriptive; no release threshold is asserted until EMN reviewers define one against representative, approved examples and a sufficiently large held-out set.

## Provider-backed synthetic generation

To generate actual structured outputs without a database or sending mail, set `OUTVEXA_EVAL_PROVIDER`, `OUTVEXA_EVAL_MODEL`, and `OUTVEXA_EVAL_API_KEY` in the shell (optionally `OUTVEXA_EVAL_BASE_URL`) and run:

```sh
npm run eval:email-quality:generate -- --partition held_out --variant-id provider-model-prompt-v1 --out /tmp/email-quality-variant.json
```

The runner calls the existing provider adapter sequentially for every case in the selected partition, sends identical synthetic input and a fixed benchmark prompt, validates against the registered PERSONALIZATION schema, and makes one controlled repair call for invalid output. It records provider/model, prompt hash, generation mode, latency, token usage, case fingerprint and structured output. It never sends email, modifies campaign data, or auto-approves output. Output files are created exclusively with mode `0600`; use a new path per run. The API key is read from the process environment and is not included in output or logs. Compare variants only when their case fingerprints and partition match.

Human annotation files must include `annotationMethod: "HUMAN"` and `reviewerId` on every row. These are reviewer declarations, not independently authenticated identities; do not report scores as human-annotated unless the declared reviewer actually reviewed the output. Model-generated self-ratings are not accepted as a substitute.
