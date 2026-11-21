---
title: Research & AI writing
section: Guides
order: 2
description: How the research brief is built, how AI Studio controls the writing, and how approval works.
---
## How a draft is made

1. **Research.** For each lead, the research step reads the sources your research rules allow — company website, news, public posts — and writes a short brief. Every fact in it keeps the link it came from.
2. **Writing.** The writer combines the brief with your business knowledge, writing rules and the campaign step's instructions.
3. **Quality checks.** Each draft is checked for unresolved variables, banned phrases, length, unsupported claims and commercial commitments. A draft with failing checks cannot be approved until it is fixed.
4. **Review.** The draft waits in the **Review queue** with its sources beside it.

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
