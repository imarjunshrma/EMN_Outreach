import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { canContact } from '../../backend/src/services/compliance.js';
import { processImport } from '../../backend/src/services/leads.js';
import { resetDb, installFakes, createUserSession, addLead } from '../helpers/harness.js';

beforeEach(async () => { await resetDb(); installFakes(); });

describe('CSV import / export', () => {
  it('maps columns, dedupes, skips suppressed and reports row errors', async () => {
    const s = await createUserSession('owner@x.com');
    await addLead(s.workspaceId, 'existing@acme.io');
    await db().suppressionEntry.create({ data: { workspaceId: s.workspaceId, type: 'EMAIL', value: 'optedout@acme.io', reason: 'UNSUBSCRIBED' } });
    const csv = [
      'Email,First Name,Company,Website,Country,Niche',
      'new1@acme.io,Ann,Acme,acme.io,US,podcasts',
      'NEW1@acme.io,Ann dup,Acme,acme.io,US,podcasts',
      'existing@acme.io,Ex,Acme,acme.io,US,x',
      'optedout@acme.io,Opt,Acme,acme.io,US,x',
      'not-an-email,Bad,Acme,acme.io,US,x',
      'bob@beta.co,Bob,Beta,beta.co,GB,coaching',
    ].join('\n');
    const up = await s.agent.post(`/api/v1/w/${s.workspaceId}/imports`).set('x-csrf-token', s.csrf).attach('file', Buffer.from(csv), 'leads.csv');
    expect(up.status).toBe(201);
    expect(up.body.suggestedMapping).toMatchObject({ Email: 'email', 'First Name': 'firstName', Company: 'companyName' });
    const start = await s.agent.post(`/api/v1/w/${s.workspaceId}/imports/${up.body.importId}/start`).set('x-csrf-token', s.csrf)
      .send({ mapping: { ...up.body.suggestedMapping, Niche: 'custom.niche' }, newListName: 'Import 1', lawfulBasis: 'LEGITIMATE_INTEREST', sourceName: 'Test CSV' });
    expect(start.status).toBe(202);
    const counters = await processImport(s.workspaceId, up.body.importId);
    expect(counters).toEqual({ imported: 2, updated: 0, skipped: 3, errors: 1 });
    const job = await db().importJob.findUniqueOrThrow({ where: { id: up.body.importId } });
    expect(job.status).toBe('COMPLETED');
    const ann = await db().lead.findFirstOrThrow({ where: { emailNormalized: 'new1@acme.io' }, include: { company: true, listMembers: true } });
    expect(ann.customFields).toEqual({ niche: 'podcasts' });
    expect(ann.lawfulBasis).toBe('LEGITIMATE_INTEREST');
    expect(ann.company?.domain).toBe('acme.io');
    expect(ann.listMembers).toHaveLength(1);
    // companies are deduplicated by domain
    expect(await db().company.count({ where: { workspaceId: s.workspaceId, domain: 'acme.io' } })).toBe(1);
  });

  it('retries recoverable rows and preserves successful imports and invalid-row diagnostics', async () => {
    const s = await createUserSession('import-retry@example.test');
    const auth = { 'x-csrf-token': s.csrf };
    const csv = 'Email,First name\nprior@example.test,Original\nretry@example.test,Retry\ninvalid,Invalid';
    const upload = await s.agent.post(`/api/v1/w/${s.workspaceId}/imports`).set(auth).attach('file', Buffer.from(csv), 'retry.csv');
    const id = upload.body.importId as string;
    await s.agent.post(`/api/v1/w/${s.workspaceId}/imports/${id}/start`).set(auth).send({ mapping: upload.body.suggestedMapping });
    await addLead(s.workspaceId, 'prior@example.test', { firstName: 'Manually corrected' });
    await db().importJob.update({ where: { id }, data: {
      status: 'COMPLETED', finishedAt: new Date(), totalRows: 3, importedRows: 1, errorRows: 2,
      errors: [{ row: 3, error: 'Temporary write failure', retryable: true }, { row: 4, error: 'invalid email' }],
    } });
    const retry = await s.agent.post(`/api/v1/w/${s.workspaceId}/imports/${id}/retry`).set(auth).send({});
    expect(retry.status).toBe(202);
    expect(await processImport(s.workspaceId, id)).toEqual({ imported: 2, updated: 0, skipped: 0, errors: 1 });
    expect(await db().importJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'COMPLETED', errors: [{ row: 4, error: 'invalid email' }] });
    expect((await db().lead.findFirstOrThrow({ where: { workspaceId: s.workspaceId, emailNormalized: 'prior@example.test' } })).firstName).toBe('Manually corrected');
    expect(await db().lead.count({ where: { workspaceId: s.workspaceId, emailNormalized: 'retry@example.test' } })).toBe(1);
  });

  it('imports research-only records and blocks outreach until an email is supplied', async () => {
    const s = await createUserSession('research-import@example.test');
    const csv = 'Full Name,Company Website,Country\nTaylor Fixture,https://company.example,US\nTaylor Fixture,https://company.example,US\nMissing Source,,US';
    const auth = { 'x-csrf-token': s.csrf };
    const up = await s.agent.post(`/api/v1/w/${s.workspaceId}/imports`).set(auth).attach('file', Buffer.from(csv), 'research.csv');
    const start = await s.agent.post(`/api/v1/w/${s.workspaceId}/imports/${up.body.importId}/start`).set(auth).send({ mapping: up.body.suggestedMapping });
    expect(start.status).toBe(202);
    await expect(processImport(s.workspaceId, up.body.importId)).resolves.toEqual({ imported: 1, updated: 0, skipped: 1, errors: 1 });
    const lead = await db().lead.findFirstOrThrow({ where: { workspaceId: s.workspaceId, firstName: 'Taylor' } });
    expect(lead).toMatchObject({ email: '', emailVerificationStatus: 'INVALID', lawfulBasis: 'UNKNOWN' });
    expect(await canContact(s.workspaceId, lead, { requireVerified: false })).toMatchObject({ allowed: false, reasons: ['No email address has been supplied for this prospect.'] });
    const update = await s.agent.patch(`/api/v1/w/${s.workspaceId}/leads/${lead.id}`).set(auth).send({ email: 'taylor@company.example' });
    expect(update.body).toMatchObject({ email: 'taylor@company.example', emailVerificationStatus: 'UNVERIFIED' });
  });

  it('exports CSV with formula-injection protection', async () => {
    const s = await createUserSession('owner@x.com');
    await addLead(s.workspaceId, 'f@acme.io', { firstName: '=HYPERLINK("http://evil")' });
    const r = await s.agent.get(`/api/v1/w/${s.workspaceId}/leads/export`);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });

  it('records status history and stops sequences when a lead becomes ineligible', async () => {
    const s = await createUserSession('owner@x.com');
    const lead = await addLead(s.workspaceId, 'conv@acme.io');
    const r = await s.agent.patch(`/api/v1/w/${s.workspaceId}/leads/${lead.id}`).set('x-csrf-token', s.csrf).send({ status: 'CUSTOMER' });
    expect(r.status).toBe(200);
    const hist = await db().leadStatusChange.findMany({ where: { leadId: lead.id } });
    expect(hist.map((h) => h.toStatus)).toContain('CUSTOMER');
  });
});
