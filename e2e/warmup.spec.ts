import { expect, test } from '@playwright/test';
import { login, workspaceBase } from './helpers';

test('opens the controlled warm-up module without enrolling a mailbox', async ({ page }) => {
  await login(page);
  const base = await workspaceBase(page);
  await page.goto(base + '/mailbox-health');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Warm-up', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email warm-up' })).toBeVisible();
  await expect(page).toHaveURL(base + '/warmup');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Email warm-up' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Enroll a mailbox' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enroll mailbox' })).toBeDisabled();
  await expect(page.getByText(/Proposed starting target/)).toBeVisible();
});

test('reviews the controlled warm-up lifecycle with simulated API responses', async ({ page }) => {
  await login(page);
  const base = await workspaceBase(page);
  const mail = { id: 'fixture-mailbox', emailAddress: 'controlled-sender@example.test', provider: 'GMAIL', status: 'CONNECTED', dailySendLimit: 3,
    domain: { spfStatus: 'PASS', dkimStatus: 'PASS', dmarcStatus: 'PASS' } };
  const program = {
    id: 'fixture-program', emailAccount: mail, status: 'READY_TO_START', dailyTarget: 1, reason: null, nextAt: null,
    config: { startAt: '2026-11-26T00:00:00Z', subject: 'Controlled test operations', body: 'A reviewed operations message for a cooperating inbox.',
      durationDays: 21, maximumTarget: 3, observationDays: 3, pauseDates: [], window: { timezone: 'UTC', days: [1,2,3,4,5], start: '09:00', end: '17:00' } },
    recipients: [] as { id: string; email: string; enabled: boolean; dailyLimit: number; authorizedAt: string }[],
    messages: [], daily: [], history: [],
  };
  await page.route('**/api/v1/w/*/warmup**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/warmup')) return route.fulfill({ json: { mailboxes: [mail], programs: [program], metrics: [] } });
    if (path.endsWith('/recipients')) {
      const input = req.postDataJSON().recipients[0];
      expect(input).toMatchObject({ email: 'controlled-recipient@example.test', authorized: true });
      program.recipients.push({ id: 'recipient', email: input.email, enabled: true, dailyLimit: input.dailyLimit, authorizedAt: new Date().toISOString() });
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/actions')) {
      const input = req.postDataJSON() as { action: 'START' | 'RESUME' | 'PAUSE' | 'STOP'; confirmed: boolean };
      expect(input.confirmed).toBe(true);
      program.status = { START: 'ACTIVE', RESUME: 'ACTIVE', PAUSE: 'PAUSED', STOP: 'STOPPED' }[input.action];
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: program });
  });
  await page.goto(base + '/warmup');
  await page.getByRole('link', { name: mail.emailAddress }).click();
  await expect(page.getByText(/READY TO START/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Edit program configuration' })).toBeVisible();
  await page.getByLabel('Recipient addresses, separated by newline or comma').fill('controlled-recipient@example.test');
  await page.getByLabel('Authorization evidence reference').fill('Confirmed controlled recipient consent');
  const confirmAction = async (name: string) => {
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name, exact: true }).click();
  };
  await confirmAction('Authorize recipients');
  await expect(page.getByText(/controlled-recipient@example.test/)).toBeVisible();
  await confirmAction('Start warm-up');
  await expect(page.getByText(/GMAIL · ACTIVE/)).toBeVisible();
  await confirmAction('Pause warm-up');
  await expect(page.getByText(/GMAIL · PAUSED/)).toBeVisible();
  await confirmAction('Resume warm-up');
  await expect(page.getByText(/GMAIL · ACTIVE/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Activity and analytics' })).toBeVisible();
  await confirmAction('Stop warm-up');
  await expect(page.getByText(/GMAIL · STOPPED/)).toBeVisible();
});
