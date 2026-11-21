# Customer onboarding

## Journey

| Step | Where | What happens |
|---|---|---|
| Discover | `/`, `/features`, `/pricing`, `/security`, `/docs` | Pricing is loaded live from `GET /public/plans` (no hard-coded prices) |
| Register | `/signup` (`POST /auth/signup`) | Name, email, organization, password (≥ 12, letters + digits), terms + privacy + AUP acceptance (`acceptTerms` must be literally `true`; `termsVersion` and `termsAcceptedAt` stored). Optional `?plan=`. A per-form `idempotencyKey` makes retries return the same tenant |
| Provision | `provisionTenant` | One transaction: organization (PENDING_SETUP) → owner membership → workspace with defaults → workspace OWNER membership → trial subscription (SaaS mode) → status history + platform audit. Then `ensureProvisioned` moves it to TRIAL/ACTIVE. If a crash happens between the two, `GET /auth/me` re-runs `ensureProvisioned` |
| Verify email | Email link → `/verify-email/<token>` (`POST /auth/verify-email`) | Single-use, hashed, 48-hour token. Required (SaaS mode or `REQUIRE_EMAIL_VERIFICATION`) before inviting or starting campaigns. Resend from the app banner. Needs `SYSTEM_SMTP_URL` to actually send |
| Onboard | `/onboarding/<orgId>` | Checklist computed from data (see below); optional steps skippable and un-skippable; "Do this later" |
| Work | `/w/<workspaceId>` | Setup reminder for owners/admins until required steps are done |

Registration can be closed with `REGISTRATION_OPEN=false`; it is open by default in SaaS mode and invite-only in self-hosted mode (the first user can always register).

## Onboarding checklist (`GET /orgs/:id/onboarding`)

| Step | Done when (computed) | Optional |
|---|---|---|
| organization | Organization has a name/time zone and the first workspace has a postal address | No |
| business | Business knowledge exists or offer facts > 20 characters | No |
| team | Organization has more than one member | Yes |
| ai | An enabled AI provider exists in any workspace | Yes |
| mailbox | A CONNECTED mailbox exists | Yes |
| domain | A domain exists and at least one is ownership-verified | Yes |
| leads | Any lead exists | Yes |
| campaign | Any campaign exists | Yes |

Progress is never stored as "done" — only skips are stored (`Organization.onboarding.skipped`). Skipping a required step is refused. Each step links to the screen that completes it.

## Invitations

Workspace admins invite by email (`POST /w/:ws/invitations`); the link is single-use, hashed and valid 7 days. Accepting creates the user if needed, a `WorkspaceMember` with the invited role, and an `OrganizationMember` with role MEMBER — never more, and never access to other workspaces of the organization.

## Tests

`multi-tenant.test.ts` (provisioning, idempotency, concurrency, terms, duplicate email, closed registration, verification, invitations), `e2e/saas.spec.ts` (sign-up form, terms error, onboarding checklist with real state, skip, workspace landing).
