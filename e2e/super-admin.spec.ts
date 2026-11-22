import { expect, test, type Page } from '@playwright/test';
import { login, sql, watchErrors } from './helpers';

// Super admin console: "log in as" a tenant (and back), user 360, data explorer edits, and maintenance mode.

const STAFF = { email: 'chief@emn-sa.test', password: 'Staff-password-12345', name: 'Chief Admin' };
const OWNER = { email: 'olga@tenant-sa.test', password: 'Owner-password-12345', name: 'Olga Owner', org: 'Orbit Foods' };
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/sa-${name}.png`, fullPage: true });

async function signupApi(page: Page, who: { email: string; password: string; name: string }, organizationName: string) {
  const r = await page.request.post('/api/v1/auth/signup', { data: { name: who.name, email: who.email, password: who.password, organizationName, acceptTerms: true } });
  expect(r.status(), await r.text()).toBe(201);
  return r.json();
}

test('super admin logs in as a tenant, edits data and controls the platform', async ({ page, browser }) => {
  const errors = watchErrors(page);
  const tenant = await signupApi(page, OWNER, OWNER.org);
  await page.context().clearCookies();
  await signupApi(page, STAFF, 'EMN Staff');
  await sql(`UPDATE "User" SET "platformRole"='SUPER_ADMIN', "isPlatformAdmin"=true WHERE email=$1`, [STAFF.email]);
  await sql(`UPDATE "User" SET "platformRole"=NULL, "isPlatformAdmin"=false WHERE email=$1`, [OWNER.email]); // a fresh install's first account is staff
  await page.context().clearCookies();

  await login(page, STAFF.email, STAFF.password);
  await expect(page).toHaveURL(/\/platform|\/w\//);
  await sql(`UPDATE "User" SET "mfaEnabled"=true WHERE email=$1`, [STAFF.email]); // console requires 2FA; the TOTP flow is covered in saas.spec
  await page.goto(`/platform/tenants/${tenant.organization.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(OWNER.org);
  await shot(page, 'tenant');

  // "Log in as owner" → lands in the tenant's workspace with the red bar.
  await page.getByRole('button', { name: 'Log in as owner' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Reason').fill('E2E: checking the customer campaign set-up');
  await dlg.getByRole('button', { name: /^Log in as/ }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${tenant.workspace.id}`));
  await expect(page.getByTestId('impersonation-banner')).toContainText(OWNER.email);
  await expect(page.getByTestId('impersonation-banner')).toContainText(STAFF.email);
  await shot(page, 'impersonating');
  await page.goto(`/w/${tenant.workspace.id}/leads`);
  await expect(page.getByTestId('impersonation-banner')).toBeVisible();

  // Back to the console, on the person's account page.
  await page.getByTestId('return-to-console').click();
  await expect(page).toHaveURL(/\/platform\/users\//);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(OWNER.name);
  await expect(page.getByTestId('impersonation-banner')).toHaveCount(0);
  await expect(page.getByText('impersonation.ended')).toBeVisible();
  await shot(page, 'user-360');

  // Data explorer: open the workspace record, rename it with a reason.
  await page.getByRole('link', { name: 'Data explorer' }).click();
  await expect(page.getByTestId('table-Lead')).toBeVisible();
  await shot(page, 'data-tables');
  await page.getByTestId('table-Workspace').click();
  await expect(page.getByTestId('data-row').first()).toBeVisible();
  await shot(page, 'data-rows');
  await page.goto(`/platform/data/Workspace/${tenant.workspace.id}`);
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('name', { exact: true }).fill('Orbit Foods HQ');
  await page.getByRole('button', { name: /Save 1 change/ }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('E2E: customer asked to rename');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved 1 change')).toBeVisible();
  await expect(page.getByTestId('field-name')).toContainText('Orbit Foods HQ');
  await expect(page.getByTestId('field-passwordHash')).toHaveCount(0);
  await shot(page, 'data-record');

  // Maintenance mode: customers see the notice and cannot save.
  await page.getByRole('link', { name: 'Global settings' }).click();
  await page.getByLabel('Pause changes for customers').check();
  await page.getByLabel('Maintenance notice').fill('E2E: upgrading until 10:00');
  await page.getByLabel('Reason for the change').fill('E2E: planned upgrade');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await shot(page, 'settings');
  const cctx = await browser.newContext();
  const cp = await cctx.newPage();
  await login(cp, OWNER.email, OWNER.password);
  await expect(cp).toHaveURL(/\/w\//);
  await expect(cp.getByTestId('maintenance-banner')).toContainText('upgrading until 10:00');
  await cctx.close();
  await page.getByLabel('Pause changes for customers').uncheck();
  await page.getByLabel('Reason for the change').fill('E2E: upgrade done');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved').last()).toBeVisible();

  expect(errors).toEqual([]);
});
