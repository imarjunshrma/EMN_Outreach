import { expect, test } from '@playwright/test';
import { ADMIN, login, totp, watchErrors, workspaceBase } from './helpers';

test.describe.configure({ mode: 'serial' });

test('first-run setup creates the owner and lands in the workspace', async ({ page }) => {
  await page.goto('/setup');
  await page.getByLabel('Your name').fill(ADMIN.name);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByLabel('Workspace name').fill(ADMIN.workspaceName);
  await page.getByRole('button', { name: 'Create account' }).click();
  await workspaceBase(page);
});

test('every v1.2 screen renders without errors (integrated navigation)', async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const base = await workspaceBase(page);
  const screens: Array<[string, RegExp]> = [
    ['/copilot', /AI Copilot/], ['/reply-assistant', /Reply assistant/], ['/workflows', /Workflow builder/], ['/workflows/new', /New workflow/],
    ['/billing', /Plan & billing/], ['/reports', /Reports & alerts/], ['/enrichment', /Verification & enrichment/], ['/mailbox-health', /Mailbox health/], ['/intelligent-sending', /Intelligent Sending/],
    ['/settings/policies', /Security & AI policies/], ['/settings/account', /My account/], ['/settings/api-keys', /API keys/], ['/pipeline', /CRM pipeline/],
    ['/inbox', /Unified inbox/], ['/leads', /Leads/], ['/campaigns', /Campaigns/], ['/domains', /Sending domains/], ['', /Good (morning|afternoon|evening)/],
  ];
  for (const [path, heading] of screens) {
    await page.goto(base + path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toHaveText(heading, { timeout: 15_000 });
    await expect(page.getByText('Couldn’t load this data')).toHaveCount(0);
  }
  // navigation links exist in the sidebar
  for (const label of ['AI Copilot', 'Reply assistant', 'Workflows', 'Plan & billing', 'Mailbox health', 'Security & AI policies']) await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('reviews lead qualification and filters excluded prospects', async ({ page }) => {
  await login(page);
  const base = await workspaceBase(page);
  await page.goto(base + '/leads');
  const email = 'qualification-fixture-' + Date.now() + '@example.test';
  await page.getByRole('button', { name: 'Add lead' }).click();
  await page.getByLabel('Email *', { exact: true }).fill(email);
  await page.getByLabel('First name', { exact: true }).fill('Fixture Lead');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByLabel('Select ' + email).check();
  await page.locator('select').filter({ has: page.getByRole('option', { name: 'Review qualification' }) }).selectOption('review_qualification');
  await page.getByLabel('Review decision').selectOption('DISQUALIFIED');
  await page.getByLabel('Review reason').fill('Isolated browser exclusion test');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: email }).getByText('Disqualified', { exact: true })).toBeVisible();
  await page.getByLabel('Qualification review').selectOption('DISQUALIFIED');
  await expect(page.getByText(email, { exact: true })).toBeVisible();
});

test('uploads a CSV, previews its mapping and queues an isolated import', async ({ page }) => {
  await login(page);
  const base = await workspaceBase(page);
  await page.goto(base + '/leads/import');
  const fileName = 'fixture-' + Date.now() + '.csv';
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName, mimeType: 'text/csv', buffer: Buffer.from('Email,First Name\nfixture-csv@example.test,CSV Fixture'),
  });
  await expect(page.getByRole('heading', { name: '2. Map columns' })).toBeVisible();
  const email = page.getByRole('row').filter({ hasText: 'fixture-csv@example.test' });
  await expect(email.getByRole('combobox')).toHaveValue('email');
  await page.getByRole('button', { name: 'Start import' }).click();
  await expect(page.getByText('Import started', { exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: fileName })).toBeVisible();
});

test('opens campaign activity for an unsent draft', async ({ page }) => {
  await login(page);
  const base = await workspaceBase(page);
  await page.goto(base + '/campaigns');
  await page.getByRole('button', { name: 'New campaign', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Isolated activity draft');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await expect(page.getByText('No campaign events yet')).toBeVisible();
  await page.goto(base + '/analytics');
  await expect(page.getByText('Tracking totals across all dates')).toBeVisible();
  await expect(page.getByText('Provider-confirmed deliveries')).toBeVisible();
  await expect(page.getByText('Connected mailbox transports do not report delivery confirmation.')).toBeVisible();
});

test('dark theme toggles, persists and applies before paint', async ({ page }) => {
  await login(page);
  const base = await workspaceBase(page);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('.card').first()).toBeVisible();
  const bg = await page.locator('.card').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgb(255, 255, 255)');
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('visual workflow builder: build with a branch, save a version, dry-run test', async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const base = await workspaceBase(page);
  await page.goto(`${base}/workflows/new`);
  await page.getByLabel('Name', { exact: true }).fill('Tag Indian leads');
  await page.getByLabel('When').selectOption('lead.created');
  await page.getByRole('button', { name: 'Add if / else' }).first().click();
  const cond = page.getByTestId('block-condition').first();
  await cond.locator('input').first().fill('IN');
  await cond.getByRole('button', { name: 'Add action' }).first().click();
  await cond.getByTestId('block-action').locator('input').first().fill('india');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}/);
  await page.getByRole('tab', { name: /^Test run/ }).click();
  await page.getByRole('button', { name: 'Run test (dry run)' }).click();
  await expect(page.getByTestId('test-log')).toContainText('lead.country eq');
  await page.getByRole('tab', { name: /^Versions/ }).click();
  await expect(page.getByText('v1')).toBeVisible();
  expect(errors).toEqual([]);
});

test('reply template + policies: auto mode needs explicit opt-in', async ({ page }) => {
  await login(page);
  const base = await workspaceBase(page);
  await page.goto(`${base}/settings/policies`);
  await expect(page.getByLabel('When a reply arrives')).toHaveValue('draft'); // human approval is the default
  await page.goto(`${base}/reply-assistant`);
  await page.getByRole('tab', { name: /^Reply templates/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Meeting yes');
  await page.getByLabel(/^Body/).fill('Hi {{firstName}}, happy to talk — here is my calendar: {{bookingLink}}');
  await page.getByText('wants meeting').click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Not Approved')).toBeVisible();
  await page.getByRole('button', { name: 'Approve (manager)' }).click();
  await expect(page.getByRole('button', { name: 'Withdraw approval' })).toBeVisible();
});

test('two-factor: enable with authenticator code, then sign-in requires it', async ({ page, context }) => {
  // A customer account: platform staff (the first user) can no longer turn 2FA off, by design.
  const U = { email: 'mfa-customer@e2e.test', password: 'Mfa-customer-12345' };
  expect((await page.request.post('/api/v1/auth/signup', { data: { name: 'MFA Customer', email: U.email, password: U.password, organizationName: 'MFA Co', acceptTerms: true } })).ok()).toBeTruthy();
  await context.clearCookies();
  await login(page, U.email, U.password);
  const base = await workspaceBase(page);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  const secret = (await page.locator('code').filter({ hasText: /^[A-Z2-7]{16,}$/ }).first().textContent())!.trim();
  await page.getByPlaceholder('123456').fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByTestId('recovery-codes')).toBeVisible();
  const recovery = ((await page.getByTestId('recovery-codes').locator('pre').textContent()) ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  expect(recovery.length).toBe(10);
  await context.clearCookies();
  await login(page, U.email, U.password);
  await expect(page.getByTestId('mfa-step')).toBeVisible();
  await page.getByLabel('Authentication code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText(/invalid|incorrect/i)).toBeVisible();
  // a fresh time step avoids the replay guard on the code used during setup
  await page.waitForTimeout(31_000);
  await page.getByLabel('Authentication code').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  const b2 = await workspaceBase(page);
  // turn it off again with a recovery code (single use) so later suites can sign in with a password
  await page.goto(`${b2}/settings/account`);
  await page.getByLabel('Password', { exact: true }).fill(U.password);
  await page.getByLabel('Code or recovery code').fill(recovery[0]);
  await page.getByRole('button', { name: 'Turn off two-factor' }).click();
  await expect(page.getByRole('button', { name: 'Set up two-factor' })).toBeVisible();
});

test('password reset request answers identically for unknown accounts', async ({ page }) => {
  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill('nobody@e2e.test');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/If an account exists/)).toBeVisible();
  await page.goto('/reset-password/not-a-real-token-but-long-enough-xyz');
  await page.getByLabel(/^New password/).fill('Another-password-123');
  await page.getByLabel('Confirm new password').fill('Another-password-123');
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText(/invalid|expired/i)).toBeVisible();
});
