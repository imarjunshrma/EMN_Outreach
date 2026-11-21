import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { login, workspaceBase } from './helpers';

// Functional sweep: seed realistic data through the API, then open EVERY screen (including detail pages),
// switch every tab, and fail on uncaught errors, console errors, 5xx API responses or an error panel.
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://emn:emn@127.0.0.1:5432/emn_e2e';

async function apiCall(page: Page, method: string, path: string, body?: unknown) {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'emn_csrf')?.value ?? '';
  const r = await page.request.fetch(`/api/v1${path}`, { method, headers: { 'x-csrf-token': decodeURIComponent(csrf), 'content-type': 'application/json' }, data: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${JSON.stringify(json)}`);
  return json;
}

test('every screen works with real data: no errors, every tab opens', async ({ page }) => {
  await login(page);
  const base = await workspaceBase(page);
  const ws = base.split('/')[2];
  const W = `/w/${ws}`;

  // ---- seed through the public API
  const lead = await apiCall(page, 'POST', `${W}/leads`, { email: 'priya@brightsmile-dental.com', firstName: 'Priya', lastName: 'Shah', title: 'Founder', companyName: 'BrightSmile Dental', companyDomain: 'brightsmile-dental.com', country: 'US', lawfulBasis: 'LEGITIMATE_INTEREST' });
  await apiCall(page, 'POST', `${W}/leads`, { email: 'tom@hillcrest-physio.co.uk', firstName: 'Tom', lastName: 'Reed', companyName: 'Hillcrest Physio', companyDomain: 'hillcrest-physio.co.uk', country: 'GB', lawfulBasis: 'LEGITIMATE_INTEREST' });
  await apiCall(page, 'POST', `${W}/lists`, { name: 'US dentists' });
  const camp = await apiCall(page, 'POST', `${W}/campaigns`, { name: 'US dentists — content growth' });
  await apiCall(page, 'POST', `${W}/opportunities`, { leadId: lead.id, title: 'BrightSmile retainer', stage: 'PROPOSAL', valueCents: 150000, expectedCloseAt: new Date(Date.now() + 20 * 86400_000).toISOString() });
  await apiCall(page, 'POST', `${W}/tasks`, { title: 'Send case study to Priya', leadId: lead.id, dueAt: new Date(Date.now() + 86400_000).toISOString() });
  const dom = await apiCall(page, 'POST', `${W}/domains`, { name: 'elitemedianetworks-mail.com' });
  await apiCall(page, 'POST', `${W}/icps`, { name: 'Clinic owners (US/UK)', criteria: { countries: ['US', 'GB'], titles: ['Founder', 'Owner'] } });
  await apiCall(page, 'POST', `${W}/reply-templates`, { name: 'Book a call', body: 'Hi {{firstName}}, happy to talk: {{bookingLink}}', categories: ['WANTS_MEETING'] });
  const wf = await apiCall(page, 'POST', `${W}/workflows`, { name: 'Tag UK leads', trigger: 'lead.created', graph: { blocks: [{ id: 'a', kind: 'action', action: 'add_tag', params: { tag: 'uk' } }] } });
  const profiles = await apiCall(page, 'GET', `${W}/ai-studio/profiles`).catch(() => []);
  const companies = await apiCall(page, 'GET', `${W}/companies`);

  // A connected mailbox and an inbound reply (no provider involved — the inbox only reads stored messages).
  const db = new pg.Client({ connectionString: DB }); await db.connect();
  const mb = (await db.query(`INSERT INTO "EmailAccount"(id,"workspaceId",provider,"emailAddress","displayName",status,"sendingWindow","updatedAt") VALUES (gen_random_uuid(),$1,'SMTP_IMAP','arjun@elitemedianetworks-mail.com','Arjun','CONNECTED','{}'::jsonb,now()) RETURNING id`, [ws])).rows[0].id;
  const conv = (await db.query(`INSERT INTO "Conversation"(id,"workspaceId","emailAccountId","leadId","campaignId","providerThreadId",subject,category,"lastMessageAt","updatedAt") VALUES (gen_random_uuid(),$1,$2,$3,$4,'t-1','Content for BrightSmile','INTERESTED',now(),now()) RETURNING id`, [ws, mb, lead.id, camp.id])).rows[0].id;
  await db.query(`INSERT INTO "EmailMessage"(id,"workspaceId","conversationId","emailAccountId",direction,"providerMessageId","fromAddress","toAddresses","ccAddresses","references",subject,"bodyText",snippet,"sentAt",category) VALUES (gen_random_uuid(),$1,$2,$3,'INBOUND','pm-1','priya@brightsmile-dental.com',ARRAY['arjun@elitemedianetworks-mail.com'],ARRAY[]::text[],ARRAY[]::text[],'Re: Content for BrightSmile','Sounds interesting. Can you share examples?','Sounds interesting','now()','INTERESTED')`, [ws, conv, mb]);
  await db.end();

  // ---- every screen
  const statics = ['', '/copilot', '/notifications', '/prospecting', '/leads', '/companies', '/leads/import', '/leads/lists', '/research', '/enrichment', '/icps', '/campaigns', '/writing', '/followups', '/inbox', '/reply-assistant',
    '/ai-studio', '/ai-studio/knowledge', '/ai-studio/writing', '/ai-studio/research', '/ai-studio/profiles', '/ai-studio/models', '/pipeline', '/tasks', '/workflows', '/workflows/new', '/automations', '/analytics', '/reports',
    '/email-accounts', '/mailbox-health', '/domains', '/settings/suppression', '/settings/compliance', '/settings/general', '/settings/team', '/settings/policies', '/settings/ai', '/settings/integrations', '/billing', '/usage',
    '/settings/api-keys', '/settings/webhooks', '/settings/audit', '/settings/jobs', '/settings/logs', '/settings/privacy', '/settings/account'];
  const details = [`/leads/${lead.id}`, `/campaigns/${camp.id}`, `/domains/${dom.id}`, `/inbox/${conv}`, `/workflows/${wf.id}`, ...(companies.data?.[0] ? [`/companies/${companies.data[0].id}`] : []), ...(Array.isArray(profiles) && profiles[0] ? [`/ai-studio/profiles/${profiles[0].id}`] : [])];

  const problems: string[] = [];
  let where = '';
  page.on('pageerror', (e) => problems.push(`${where} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`${where} console: ${m.text().slice(0, 300)}`); });
  page.on('response', (r) => { if (r.url().includes('/api/v1/') && r.status() >= 500) problems.push(`${where} API ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });

  const absolute = ['/admin', '/platform', '/platform/tenants', '/platform/plans', '/platform/support', '/platform/audit'];
  for (const p of [...statics, ...details, ...absolute]) {
    where = p;
    await page.goto(absolute.includes(p) ? p : base + p);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1').first(), `heading on ${p}`).toBeVisible({ timeout: 15_000 });
    if (await page.getByText('Couldn’t load this data').count()) problems.push(`${p}: error panel — ${(await page.getByRole('alert').first().textContent())?.slice(0, 200)}`);
    const tabs = page.getByRole('tab');
    for (let i = 0; i < (await tabs.count()); i++) {
      where = `${p} [tab ${i}]`;
      await tabs.nth(i).click();
      await page.waitForLoadState('networkidle');
      if (await page.getByText('Couldn’t load this data').count()) problems.push(`${where}: error panel`);
    }
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

test('command palette and mobile menu navigate', async ({ page }) => {
  await login(page);
  const base = await workspaceBase(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Go to/).fill('workflows');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${base}/workflows$`));
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByLabel('Open menu').click();
  await page.getByRole('link', { name: 'Inbox', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${base}/inbox$`));
});
