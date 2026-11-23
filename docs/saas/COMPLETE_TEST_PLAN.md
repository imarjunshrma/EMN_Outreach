# Complete test plan — Outvexa

How the product is tested, what each layer is responsible for, and how to run it. Results are in `COMPLETE_TEST_RESULTS.md`.

## Layers

| Layer | Tool | Scope | Where |
|---|---|---|---|
| Unit | Vitest | Pure logic: permissions, tenant guards, email syntax and risk, SMTP protocol parsing, adapters, safety rules | `tests/unit` (10 files) |
| Integration | Vitest + Supertest against the real Express app, PostgreSQL and Redis | Every API area through HTTP with real sessions, CSRF, roles and tenants; background job functions called directly | `tests/integration` (23 files) |
| Browser | Playwright + Chrome against the built frontend and API | Sign-up, onboarding, main workspace screens, theme, page crawl for errors, platform console end to end | `e2e` (5 specs) |
| Static | TypeScript, ESLint | Types across all packages; lint rules | — |
| Supply chain | `npm audit --omit=dev` | Production dependencies | — |
| Schema | `prisma migrate diff` | Migrations produce exactly the schema | — |

## Rules for every test

- No real email, payment, OAuth, DNS or AI call: providers are fakes (`tests/helpers/fakes.ts`), DNS is stubbed, SMTP probing stays off.
- Each test starts from an empty database (`resetDb`) and its own users and workspaces.
- Security checks are never disabled to make a test pass.
- Every bug fix gets a test that fails without the fix.

## What each feature must prove

For every API area: success path; validation errors (400); missing session (401); insufficient role (403); another tenant's record (404); malformed ID (404); audit entry for changes where the product records one.

For background work: idempotency (a job delivered twice does nothing the second time); pause and cancel respected; failures recorded without losing data.

For the platform console: permission per staff role, reason required, audit entry, guard rails (last super admin, last owner, own role).

## Running it

```bash
# services: PostgreSQL and Redis running locally
npm run db:migrate
npx vitest run                     # unit + integration
npx vitest run --coverage.enabled  # with coverage (needs @vitest/coverage-v8)
E2E_DATABASE_URL=postgresql://emn:emn@127.0.0.1:5432/emn_e2e E2E_REDIS_URL=redis://127.0.0.1:6379/14 npm run test:e2e
npx tsc -p tsconfig.json --noEmit && (cd frontend && npx tsc --noEmit)
npx eslint .
npm audit --omit=dev && (cd frontend && npm audit --omit=dev)
```

The browser suite runs in order: `app.spec` creates the admin account that later specs sign in with, so run the whole suite rather than one file.

## Gaps in the plan

Live-provider tests (Google, Microsoft, Stripe, Razorpay, Cloudflare, AI providers) need sandbox credentials and are not automated. There is no load test, no frontend unit coverage, and no visual regression baseline beyond screenshots.
