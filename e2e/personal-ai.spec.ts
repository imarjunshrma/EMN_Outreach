import { expect, test, type Page } from '@playwright/test';
import { login, sql, totp, watchErrors, workspaceBase } from './helpers';

// Runs after app.spec (the first account of the installation must stay the e2e admin).
// Personal AI subscriptions in the browser: owner-only screens, workflow builder, writing playbook,
// "Generate emails" on a prospect, queue dashboard, and invisibility for everyone else.
// No real Claude/Codex account is used: connections stay disconnected and no worker runs here.
test.describe.configure({ mode: 'serial' });
const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });
const OWNER = { email: 'aiowner@emn-e2e.test', password: 'Owner-password-12345' };
const OTHER = { email: 'notowner@emn-e2e.test', password: 'Other-password-12345' };

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const csrf = decodeURIComponent(document.cookie.match(/emn_csrf=([^;]+)/)?.[1] ?? '');
    const r = await fetch(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { method, path, body });
}

test('owner: subscription cards, workflow builder, playbook history, prospect generation and queue', async ({ page }) => {
  const errors = watchErrors(page);
  const reg = await page.request.post('/api/v1/auth/signup', { data: { name: 'AI Owner', email: OWNER.email, password: OWNER.password, organizationName: 'EMN Owner', acceptTerms: true } });
  expect(reg.ok()).toBeTruthy();
  await sql(`UPDATE "User" SET "platformRole" = 'SUPER_ADMIN' WHERE email = $1`, [OWNER.email]);
  await login(page, OWNER.email, OWNER.password);
  const base = await workspaceBase(page);
  // Without two-factor sign-in the owner does not get the feature.
  expect((await api(page, 'GET', '/ai-subscriptions/access')).body.allowed).toBe(false);
  const secret = (await api(page, 'POST', '/auth/mfa/setup')).body.secret as string;
  expect((await api(page, 'POST', '/auth/mfa/enable', { code: totp(secret) })).status).toBe(200);
  expect((await api(page, 'GET', '/ai-subscriptions/access')).body.allowed).toBe(true);

  // Settings → AI providers: the two subscription cards above the API providers.
  await page.goto(`${base}/settings/ai`);
  await expect(page.getByRole('heading', { name: 'My subscriptions' })).toBeVisible();
  await expect(page.getByText('Claude — My Subscription')).toBeVisible();
  await expect(page.getByText('Codex — My ChatGPT Subscription')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'API providers' })).toBeVisible();
  // An API key is refused as a subscription token, with a clear message.
  await page.getByLabel('Subscription token').fill('sk-ant-api03-thisIsAnApiKeyNotASubscriptionToken123');
  await page.getByRole('button', { name: 'Connect Claude' }).click();
  await expect(page.getByText(/does not look like a token from `claude setup-token`/)).toBeVisible();
  await shot(page, 'ai-subscriptions');

  // Workflow builder: presets, edit a stage, reorder, save, activate.
  await page.getByRole('tab', { name: 'AI Workflow Builder' }).click();
  const nav = page.getByRole('navigation', { name: 'Workflows' });
  for (const name of ['Claude only', 'Codex only', 'Claude → Codex', 'Codex → Claude', 'Existing API provider only']) await expect(nav.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(nav.getByRole('button', { name: /Example: research → draft → humanize → review/ })).toContainText('Active');
  await expect(page.getByText(/uses Claude, which is disconnected/).first()).toBeVisible(); // honest preview warning
  await nav.getByRole('button', { name: /^Claude → Codex/ }).click();
  await page.getByRole('button', { name: /3\. Humanization/ }).click();
  await page.getByLabel('Custom instructions').fill('Keep each email under 70 words.');
  const order = page.getByRole('list', { name: 'Stages in run order' }).getByRole('listitem');
  await page.getByRole('button', { name: 'Move up' }).nth(2).click(); // humanization above drafting
  await expect(order.nth(1)).toContainText('Humanization');
  await page.getByRole('button', { name: 'Move down' }).nth(1).click(); // back to the right order
  await expect(order.nth(2)).toContainText('Humanization');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Workflow saved')).toBeVisible();
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(nav.getByRole('button', { name: /^Claude → Codex/ })).toContainText('Active');
  await shot(page, 'ai-workflow-builder');

  // Writing playbook: edit → version 2, restore → version 3.
  await page.getByRole('tab', { name: 'Writing Playbook' }).click();
  const editor = page.getByLabel('Playbook (Markdown)');
  await expect(editor).toHaveValue(/We do NOT offer LinkedIn marketing\./);
  await editor.fill(`${await editor.inputValue()}\n\nNever use the word "synergy".`);
  await page.getByLabel('Change note (optional)').fill('No synergy');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText('Saved as version 2')).toBeVisible();
  await page.getByRole('button', { name: /^Version 1/ }).click();
  page.once('dialog', (d) => void d.accept()); // confirmation prompt
  await page.getByRole('button', { name: 'Restore this version' }).click();
  await expect(page.getByText('Restored as version 3')).toBeVisible();
  await shot(page, 'ai-playbook');

  // Prospect: "Generate emails" tab queues a run and never sends anything.
  const lead = await api(page, 'POST', `${base}/leads`, { email: 'jane@clinic-e2e.test', firstName: 'Jane' });
  expect(lead.status).toBe(201);
  await page.goto(`${base}/leads/${lead.body.id}?tab=ai`);
  await expect(page.getByRole('button', { name: 'Generate with selected workflow' })).toBeVisible();
  await page.getByRole('button', { name: 'Generate with Claude' }).click();
  await expect(page.getByText('Generation queued')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Stages' })).toContainText('1. Prospect research');
  await expect(page.getByRole('list', { name: 'Stages' })).toContainText('Claude');
  await expect(page.getByText(/Nothing is sent from here/)).toBeVisible();
  await shot(page, 'ai-generate-panel');

  // Queue dashboard shows the pending run.
  await page.goto(`${base}/settings/ai?tab=queue`);
  await expect(page.getByRole('tab', { name: 'AI queue' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Claude subscription').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Execution log' }).or(page.getByText('Execution log'))).toBeVisible();
  expect((await sql(`SELECT count(*)::int AS n FROM "AiWorkflowRun"`))[0].n).toBe(1);
  expect((await sql(`SELECT count(*)::int AS n FROM "OutboundEmail"`))[0].n).toBe(0);
  await shot(page, 'ai-queue');
  expect(errors).toEqual([]);
});

test('everyone else: no subscription UI and 404 from the API', async ({ page }) => {
  const errors = watchErrors(page);
  const reg = await page.request.post('/api/v1/auth/signup', { data: { name: 'Not Owner', email: OTHER.email, password: OTHER.password, organizationName: 'Other Co', acceptTerms: true } });
  expect(reg.ok()).toBeTruthy();
  await login(page, OTHER.email, OTHER.password);
  const base = await workspaceBase(page);
  await page.goto(`${base}/settings/ai`);
  await expect(page.getByRole('heading', { name: 'AI providers' })).toBeVisible();
  await expect(page.getByText('Claude — My Subscription')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'AI Workflow Builder' })).toHaveCount(0);
  await page.goto(`${base}/settings/ai?tab=workflows`);
  await expect(page.getByRole('tab', { name: 'AI Workflow Builder' })).toHaveCount(0);
  for (const p of ['/ai-subscriptions/connections', '/ai-workflows', '/ai-playbook', `${base}/ai-queue`]) expect((await api(page, 'GET', p)).status, p).toBe(404);
  expect(errors).toEqual([]);
});
