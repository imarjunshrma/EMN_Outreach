---
title: Research & AI writing
section: Guides
order: 2
description: How the research brief is built, how AI Studio controls the writing, and how approval works.
---
## How a draft is made

1. **Business knowledge.** Enter a public company website to collect source pages and draft knowledge and services. Review the source quotes and approve the versions you want to use. AI revisions appear as inactive versions.
2. **Import and research.** Import a CSV or the first worksheet of an Excel `.xlsx` file. Rows with a full name and a company website or public profile can enter as research-only prospects. Add and verify an email address before they can enter an outreach campaign.
3. **Qualification.** Review the prospect's evidence and identity separately from their fit against the active ICP. Use **Refresh research** on the prospect profile to request an updated report.
4. **Draft and evaluate.** Select an approved service version in the campaign. The writer uses current prospect evidence and approved offer facts. An independent fact check and quality rules evaluate the draft. A failed evaluation can trigger one rewrite and another evaluation.
5. **Review.** Passing drafts wait for human approval. Held drafts show the evidence or quality issues that need attention.

Research can read company sites and supplied public pages. An existing search provider can help discover pages. Search snippets are discovery records. Source pages provide evidence for extracted claims. Links to restricted sites or videos with unavailable transcripts appear as source limitations.

## AI Studio

| Area | What it controls |
|---|---|
| Business knowledge | What you sell, to whom, proof points, and facts the AI may use. The AI treats anything not written here as unknown. |
| Writing rules | Tone, length, phrases to avoid, sign-off. |
| Research rules | Which sources are allowed, how recent facts must be, topics to avoid. |
| Prompt library | Reusable prompt profiles for different campaigns. |
| Models & budgets | Which model each task uses, and monthly spending caps. |

> [!security]
> The AI never quotes prices, discounts, guarantees or deadlines unless they are written in your business knowledge, and drafts that mention them are flagged for careful review.

## Providers and cost

You connect a supported hosted or local text model under **Settings → AI providers**. Costs are estimated from prices you configure and counted toward both your workspace budget and your plan's monthly AI allowance. When a budget is used up, AI tasks stop with `AI_BUDGET_EXCEEDED` until the next month or until the budget is raised; nothing is sent half-written.
