---
title: Importing and managing leads
section: Guides
order: 1
description: Bring prospects in from CSV, Apollo or search, keep lists clean, and verify addresses before sending.
---
## Import a CSV

:::steps
### Prepare the file
Use one row per person and a header row. The only required column is the email address. Useful extra columns: first name, last name, job title, company name, company website, country and LinkedIn URL. Files up to 20 MB are accepted.

### Upload and map columns
Open **Prospects → Import & export → Import CSV**. Match each column to a lead field, or to a custom field. Columns you do not map are ignored.

### Review the result
The import runs in the background and reports how many rows were created, updated, skipped as duplicates, or rejected — for example because the address is invalid or on your suppression list.
:::

> [!note]
> A lead's email address is unique within a workspace, so importing the same person twice never creates a copy. When you upload, choose whether existing leads are **skipped** or **updated** with the new values.

## Find prospects

**Prospects → Prospect discovery** searches Apollo (with your own Apollo key) and the web for people and companies that match an ideal customer profile. Add the results you want to a list; nothing is imported automatically.

## Verify before you send

Open **Prospects → Verification** and run verification on a list. Verification can use several providers in order — the *waterfall* — and stops at the first definite answer, so you pay only for the checks you need. Leads marked invalid are excluded from campaigns. Each verification counts toward your plan's monthly verification allowance.

## Score against your ICP

Define your ideal customer under **Prospects → Ideal customer profile**: industries, company size, titles, countries and exclusions. Scoring explains each score, so you can see why a lead ranked high or low.

## Suppression

Anyone who unsubscribes, complains or hard-bounces is added to **Deliverability → Suppression list** and is never emailed again from that workspace. You can add addresses or whole domains manually, and export the list.
