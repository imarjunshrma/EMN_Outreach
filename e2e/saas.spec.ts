import { expect, test, type Page } from '@playwright/test';
import { login, watchErrors, workspaceBase } from './helpers';

// Public website, documentation, self-service sign-up, onboarding, organization settings, tenant
// isolation in the browser, and the platform console. Self-hosted mode (no billing) with
// REGISTRATION_OPEN=true; no external provider is contacted.
test.describe.configure({ mode: 'serial' });
const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });
const CUSTOMER = { name: 'Bina Customer', email: 'bina@beta-e2e.test', password: 'Beta-password-12345', org: 'Beta Clinics' };

test('public website pages render, stay light, and link to sign-up', async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Cold email that shows you did the homework/);
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);
  await shot(page, 'site-home');
  for (const [path, h] of [['/features', /Everything between/], ['/security', /How we protect/], ['/legal/terms', /Terms of Service/], ['/legal/privacy', /Privacy Policy/]] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(h);
  }
  await page.goto('/pricing');
  await expect(page.getByTestId('plan-starter')).toBeVisible();
  await expect(page.getByTestId('plan-agency')).toContainText('A workspace for every client');
  await page.getByRole('button', { name: /Yearly/ }).click();
  await expect(page.getByTestId('plan-growth')).toContainText('billed yearly');
  await shot(page, 'site-pricing');
  await page.getByTestId('plan-growth').getByRole('link', { name: /Start/ }).click();
  await expect(page).toHaveURL(/\/signup\?plan=growth/);
  expect(errors).toEqual([]);
});

test('documentation: guides, search and generated API reference', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/docs');
  await expect(page.getByTestId('doc-article').getByRole('heading', { level: 1 })).toHaveText('Introduction');
  await page.getByRole('link', { name: 'Quickstart', exact: true }).first().click();
  await expect(page).toHaveURL(/\/docs\/quickstart/);
  await expect(page.getByRole('heading', { name: 'Connect a mailbox' })).toBeVisible();
  await shot(page, 'docs-quickstart');
  await page.getByTestId('docs-search-open').click();
  await page.getByLabel('Search', { exact: true }).fill('signature');
  await expect(page.getByRole('option').first()).toContainText(/Webhooks|signature/i);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/docs\/webhooks/);
  await page.goto('/docs/api');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('API reference');
  await page.getByRole('link', { name: /^Leads/ }).first().click();
  await expect(page.getByTestId('api-op').first()).toBeVisible();
  await expect(page.getByText('Workspace member or API key').first()).toBeVisible();
  await shot(page, 'docs-api-leads');
  await page.goto('/docs/api/billing');
  await expect(page.getByText('/api/v1/orgs/{organizationId}/billing/checkout').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('sign-up creates an organization and opens the real setup checklist', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/signup');
  await page.getByLabel('Your name').fill(CUSTOMER.name);
  await page.getByLabel('Work email').fill(CUSTOMER.email);
  await page.getByLabel('Company or agency name').fill(CUSTOMER.org);
  await page.getByLabel('Password').fill(CUSTOMER.password);
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByText(/Please accept the Terms/)).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page).toHaveURL(/\/onboarding\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { name: 'Set up your organization' })).toBeVisible();
  await expect(page.locator('[data-step="business"]')).toHaveAttribute('data-done', 'false');
  await expect(page.locator('[data-step="team"]')).toHaveAttribute('data-done', 'false');
  await page.locator('[data-step="team"]').getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.locator('[data-step="team"]')).toContainText('Skipped');
  await shot(page, 'onboarding');
  await page.getByRole('button', { name: 'Do this later' }).click();
  const base = await workspaceBase(page);
  await expect(page.getByTestId('setup-reminder')).toHaveCount(0); // hidden after "later"
  expect(base).toBeTruthy();
  expect(errors).toEqual([]);
});

test('a customer cannot open another organization\'s workspace or settings by URL', async ({ page, browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin);
  const adminBase = await workspaceBase(admin);
  const adminOrg = await admin.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).organizations[0].id as string);
  await adminCtx.close();

  await login(page, CUSTOMER.email, CUSTOMER.password);
  await workspaceBase(page);
  await page.goto(`${adminBase}/leads`);
  await expect(page.getByText(/Workspace not found or you are not a member/)).toBeVisible();
  await page.goto(`/org/${adminOrg}`);
  await expect(page.getByText(/not found/i).first()).toBeVisible();
  await page.goto('/platform');
  await expect(page.getByText('Page not found')).toBeVisible();
});

test('organization settings: profile, members, workspaces and usage', async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, CUSTOMER.email, CUSTOMER.password);
  await workspaceBase(page);
  const orgId = await page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).organizations[0].id as string);
  await page.goto(`/org/${orgId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(CUSTOMER.org);
  await page.getByLabel('Display name').fill('Beta');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Organization saved')).toBeVisible();
  await page.getByRole('tab', { name: 'Members' }).click();
  await expect(page.getByText(CUSTOMER.email)).toBeVisible();
  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page.getByText(/This period/)).toBeVisible();
  await page.getByRole('tab', { name: 'Workspaces' }).click();
  await page.getByRole('button', { name: 'Add workspace' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Beta North');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}\/settings\/general/);
  await page.goto(`/org/${orgId}?tab=workspaces`);
  await expect(page.getByRole('link', { name: 'Beta North' })).toBeVisible();
  await shot(page, 'org-workspaces');
  await page.goto(`/org/${orgId}?tab=billing`);
  await expect(page.getByText('Self-hosted mode')).toBeVisible();
  expect(errors).toEqual([]);
});

test('platform console: metrics, tenant search, audited suspension and reactivation', async ({ page, browser }) => {
  const errors = watchErrors(page);
  await login(page);
  await workspaceBase(page);
  await page.goto('/platform');
  await expect(page.getByTestId('platform-tiles')).toContainText('Tenants');
  await shot(page, 'platform-overview');
  await page.getByRole('link', { name: 'Tenants' }).click();
  await page.getByLabel('Search tenants').fill('Beta');
  await page.getByRole('link', { name: CUSTOMER.org }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(CUSTOMER.org);
  await page.getByRole('button', { name: 'Suspend' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Suspend' })).toBeDisabled();
  await dialog.getByLabel('Reason').fill('E2E: chargeback review');
  await dialog.getByRole('button', { name: 'Suspend' }).click();
  await expect(page.getByText('Suspend: done')).toBeVisible();
  await expect(page.getByText('E2E: chargeback review').first()).toBeVisible();
  await shot(page, 'platform-tenant');

  // the customer is now read-only
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await login(c, CUSTOMER.email, CUSTOMER.password);
  const base = await workspaceBase(c);
  const res = await c.evaluate(async (b) => {
    const csrf = decodeURIComponent(document.cookie.match(/emn_csrf=([^;]+)/)?.[1] ?? '');
    const r = await fetch(`/api/v1${b}/leads`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ email: 'x@y.test' }) });
    return { status: r.status, body: await r.json() };
  }, base);
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('TENANT_INACTIVE');
  await ctx.close();

  await page.getByRole('button', { name: 'Reactivate' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('E2E: review closed');
  await page.getByRole('dialog').getByRole('button', { name: 'Reactivate' }).click();
  await expect(page.getByText('Reactivate: done')).toBeVisible();
  await page.goto('/platform/audit');
  await expect(page.getByText('tenant.viewed').first()).toBeVisible();
  expect(errors).toEqual([]);
});
