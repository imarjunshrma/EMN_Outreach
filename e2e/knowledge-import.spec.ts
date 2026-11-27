import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { Worker } from 'bullmq';
import JSZip from 'jszip';
import XLSX from 'xlsx';
import { IMPORT_ENTITIES, importFieldKind, type ImportEntityType } from '../shared/src/knowledge-import';
import { login, workspaceBase } from './helpers';

test.skip(process.env.KNOWLEDGE_IMPORT_E2E !== '1', 'Run with playwright.knowledge-import.config.ts and an isolated migrated database.');

const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const companyDescription = 'Fixture company provides heliotrope telemetry investigations.';
const serviceDescription = 'The approved field service tracks cobalt aurora telemetry.';
const unapprovedClaim = 'Unverified zirconia windfall totals eight million dollars.';
const serviceTitle = 'Cobalt aurora telemetry';

function extractFixture(prompt: string) {
  const source = prompt.match(/<untrusted_content source="knowledge_import">\n([\s\S]+?)\n<\/untrusted_content>/)?.[1];
  if (!source) throw new Error('Extraction prompt is missing its delimited source');
  return {
    items: source.split('\n\n').map((entry) => {
      const [header, ...lines] = entry.split('\n');
      const meta: { sourceIndex: number; worksheetEntityType?: ImportEntityType } = JSON.parse(header);
      const extracted = lines.flatMap((line) => {
        const separator = line.indexOf(': ');
        if (separator < 0) return [];
        const key = line.slice(0, separator);
        if (key.startsWith('related')) return [];
        const value = line.slice(separator + 2);
        return [{ key, values: importFieldKind(key) === 'list' ? value.split(',').map((v) => v.trim()) : [value] }];
      });
      return {
        sourceIndex: meta.sourceIndex,
        entityType: meta.worksheetEntityType ?? 'PROOF_CASE_STUDY',
        fields: meta.worksheetEntityType ? extracted : [{ key: 'name', values: ['Zirconia results claim'] }, { key: 'description', values: [lines[0]] }],
        confidence: 0.98,
        classification: meta.worksheetEntityType === 'PROOF_CASE_STUDY' || !meta.worksheetEntityType ? 'CLAIM' : 'EXPLICIT_FACT',
        sourceExcerpt: lines[0],
        relationships: [],
        mappingExplanation: 'Mapped from the synthetic worksheet or supporting document.',
      };
    }),
  };
}

async function localProvider() {
  const prompts: string[] = [];
  const errors: string[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      let result: unknown;
      if (req.url === '/v1/chat/completions') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body: { messages: Array<{ content: string }> } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const prompt = body.messages.map((message) => message.content).join('\n');
        prompts.push(prompt);
        const data = prompt.includes('source="knowledge_import"') ? extractFixture(prompt)
          : prompt.includes('source="workspace_snapshot"') ? {
            answer: prompt.includes(companyDescription) ? companyDescription : 'No imported business knowledge was available.',
            recommendations: [], proposedActions: [],
          } : null;
        if (!data) throw new Error('Unexpected workspace AI task in the importer browser test');
        result = { choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 25, completion_tokens: 15 } };
      } else if (req.url === '/v1/models') {
        result = { data: [{ id: 'knowledge-fixture-v1' }] };
      } else {
        throw new Error(`Unexpected provider request ${req.url}`);
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      errors.push((error as Error).message);
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'Unexpected synthetic AI request' } }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, 'localhost', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture provider did not bind a port');
  return {
    url: `http://localhost:${address.port}/v1`,
    prompts,
    errors,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function api<T>(page: Page, base: string, path: string, method = 'GET', data?: object) {
  const cookies = await page.context().cookies();
  const token = cookies.find((cookie) => cookie.name === 'emn_csrf')?.value ?? '';
  const response = await page.request.fetch(`/api/v1${base}${path}`, {
    method, data, headers: { 'x-csrf-token': decodeURIComponent(token) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function supportingDocument() {
  const archive = new JSZip();
  archive.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  archive.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${unapprovedClaim}</w:t></w:r></w:p></w:body></w:document>`);
  return archive.generateAsync({ type: 'nodebuffer' });
}

const companyName = 'Heliotrope Telemetry';
const workbookRecord = (type: string) => ({
  name: type === 'COMPANY_PROFILE' ? companyName : type === 'SERVICE' ? serviceTitle : `Synthetic ${type.toLowerCase().replaceAll('_', ' ')}`,
  description: type === 'COMPANY_PROFILE' ? companyDescription : type === 'SERVICE' ? 'Baseline telemetry description.' : `Synthetic description for ${type}.`,
});

function populateTemplate(template: Buffer, updatedService?: string) {
  const workbook = XLSX.read(template, { type: 'buffer' });
  expect(workbook.SheetNames).toEqual([...Object.values(IMPORT_ENTITIES).map((item) => item.sheet), 'Instructions']);
  for (const [entity, { sheet }] of Object.entries(IMPORT_ENTITIES)) {
    if (updatedService && entity !== 'SERVICE') continue;
    const { name, description } = workbookRecord(entity);
    XLSX.utils.sheet_add_aoa(workbook.Sheets[sheet], [[`fixture-${entity.toLowerCase()}`, name, updatedService ?? description]], { origin: 'A2' });
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function upload(page: Page, base: string, workbook: Buffer, support?: Buffer) {
  await page.goto(`${base}/ai-studio/imports`);
  const files = [{ name: 'synthetic-knowledge.xlsx', mimeType: xlsxMime, buffer: workbook }];
  if (support) files.push({ name: 'unverified-proof.docx', mimeType: docxMime, buffer: support });
  await page.getByLabel('Choose files').setInputFiles(files);
  await page.getByRole('button', { name: 'Upload files', exact: true }).click();
  await expect(page).toHaveURL(/\/ai-studio\/imports\/[0-9a-f-]{36}$/, { timeout: 30000 });
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

test('reviews and applies the workbook, retrieves eligible knowledge and deduplicates re-imports', async ({ page }) => {
  const provider = await localProvider();
  const { QUEUES, closeQueues } = await import('../backend/src/core/queues.js');
  const { newRedis, closeRedis } = await import('../backend/src/core/redis.js');
  const { disconnectDb } = await import('../backend/src/core/db.js');
  const { processorFor } = await import('../worker/src/processors.js');
  const worker = new Worker(QUEUES.imports, processorFor(QUEUES.imports), {
    prefix: process.env.QUEUE_PREFIX,
    connection: newRedis(),
    concurrency: 2,
  });
  try {
    await worker.waitUntilReady();
    const email = `knowledge-fixture-${randomUUID()}@example.test`;
    const password = 'Knowledge-fixture-password-123';
    await page.goto('/signup');
    await page.getByLabel('Your name').fill('Importer Fixture');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Company or agency name').fill('Isolated Importer Fixture');
    await page.getByLabel('Password').fill(password);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Create my account' }).click();
    await page.getByRole('button', { name: 'Do this later' }).click();
    await workspaceBase(page);
    await api(page, '', '/auth/logout', 'POST');
    await login(page, email, password);
    const base = await workspaceBase(page);

    await api(page, base, '/ai/providers', 'PUT', {
      provider: 'CUSTOM_OPENAI', apiKey: 'synthetic-test-key', defaultModel: 'knowledge-fixture-v1', baseUrl: provider.url,
    });
    await api(page, base, '/ai/default-provider', 'PUT', { provider: 'CUSTOM_OPENAI', applyToAll: true });
    await page.goto(`${base}/ai-studio`);
    await page.getByRole('link', { name: /Knowledge importer Upload workbooks/i }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download XLSX template' }).click();
    const template = await readFile((await (await downloaded).path())!);
    const workbook = populateTemplate(template);
    const docx = await supportingDocument();
    const sessionId = await upload(page, base, workbook, docx);
    await expect(page.getByRole('heading', { name: 'Review extracted records' })).toBeVisible();
    for (const { sheet } of Object.values(IMPORT_ENTITIES)) {
      await expect(page.getByText(new RegExp(`${sheet}:row-2`))).toBeVisible({ timeout: 60_000 });
    }
    await expect(page.getByText(/unverified-proof\.docx · paragraph-1/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply approved items' })).toBeDisabled();

    const company = page.locator('article').filter({ has: page.getByRole('heading', { name: companyName, exact: true }) });
    const service = page.locator('article').filter({ has: page.getByRole('heading', { name: serviceTitle, exact: true }) });
    const proof = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Zirconia results claim', exact: true }) });
    const audience = page.locator('article').filter({ has: page.getByRole('heading', { name: workbookRecord('TARGET_AUDIENCE').name, exact: true }) });
    await company.getByText('Review details', { exact: true }).click();
    await expect(company.getByText('98%')).toBeVisible();
    await expect(company.getByText('Source excerpt')).toBeVisible();
    await company.getByRole('button', { name: 'Approve', exact: true }).click();
    await service.getByText('Review details', { exact: true }).click();
    await service.getByRole('button', { name: 'Edit proposed fields' }).click();
    await service.getByLabel('Description', { exact: true }).fill(serviceDescription);
    await service.getByLabel('Review notes').fill('Checked by the synthetic reviewer.');
    await service.getByRole('button', { name: 'Approve', exact: true }).click();
    await audience.getByText('Review details', { exact: true }).click();
    await audience.getByRole('button', { name: 'Approve', exact: true }).click();
    await proof.getByText('Review details', { exact: true }).click();
    await expect(proof.getByText('Unverified', { exact: true })).toBeVisible();
    await expect(proof.getByText(unapprovedClaim, { exact: true }).first()).toBeVisible();
    await proof.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(proof.getByText('Rejected', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Apply approved items' }).click();
    await expect(service.getByText('Applied', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(company.getByText('Applied', { exact: true })).toBeVisible();
    await expect(audience.getByText('Applied', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Audit history' })).toBeVisible();
    const session = await api<{ items: Array<{ status: string; destinationEntityId: string | null }>; auditEvents: unknown[] }>(page, base, `/ai-studio/imports/${sessionId}`);
    expect(session.items.filter((item) => item.status === 'APPLIED' && item.destinationEntityId)).toHaveLength(3);
    expect(session.auditEvents.length).toBeGreaterThan(2);
    const config = await api<{ version: number; data: object }>(page, base, '/ai-studio/config/knowledge');
    expect(JSON.stringify(config.data)).toContain(companyName);

    await page.goto(`${base}/ai-studio/knowledge`);
    const catalogRecord = page.locator('section').filter({ has: page.getByRole('heading', { name: serviceTitle, exact: true }) });
    await expect(catalogRecord.getByText(serviceDescription)).toBeVisible();
    await expect(catalogRecord.getByText('Draft', { exact: true })).toBeVisible();
    await expect(catalogRecord.getByText('Version 1', { exact: false }).first()).toBeVisible();
    await catalogRecord.getByRole('button', { name: 'Approve version' }).click();
    await expect(catalogRecord.getByText('Approved', { exact: true })).toBeVisible();

    await page.goto(`${base}/copilot`);
    await page.getByPlaceholder('Ask the Copilot…').fill('What does Heliotrope Telemetry do?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByText(companyDescription, { exact: true })).toBeVisible({ timeout: 30_000 });
    const copilotPrompt = provider.prompts.find((prompt) => prompt.includes('source="workspace_snapshot"'));
    expect(copilotPrompt).toContain(companyDescription);
    expect(copilotPrompt).not.toContain(unapprovedClaim);
    const workspaceId = base.split('/').at(-1)!;
    const { retrieveImportedKnowledge } = await import('../backend/src/services/knowledge-import-apply.js');
    const { buildSnapshot } = await import('../backend/src/services/ai-studio.js');
    const research = await retrieveImportedKnowledge(workspaceId, '', ['TARGET_AUDIENCE', 'TARGET_PERSONA', 'ICP_CRITERIA', 'BUSINESS_OPPORTUNITY', 'RESEARCH_RULE'], 6);
    expect(research).toHaveLength(1);
    expect(research[0].text).toContain(workbookRecord('TARGET_AUDIENCE').name);
    const campaign = await api<{ id: string }>(page, base, '/campaigns', 'POST', { name: 'Synthetic importer context' });
    const personalization = await buildSnapshot(workspaceId, campaign.id);
    expect(JSON.stringify(personalization.knowledge.data)).toContain(companyDescription);
    expect(JSON.stringify(personalization)).not.toContain(unapprovedClaim);

    const duplicateId = await upload(page, base, workbook, docx);
    expect(duplicateId).toBe(sessionId);
    const afterDuplicate = await api<{ version: number }>(page, base, '/ai-studio/config/knowledge');
    expect(afterDuplicate.version).toBe(config.version);
    const services = await api<Array<{ name: string; versions: unknown[] }>>(page, base, '/ai-studio/services');
    expect(services.filter((item) => item.name === serviceTitle).map((item) => item.versions.length)).toEqual([1]);

    const conflictId = await upload(page, base, populateTemplate(template, 'Proposed replacement telemetry description.'));
    expect(conflictId).not.toBe(sessionId);
    const conflict = page.locator('article').filter({ has: page.getByRole('heading', { name: serviceTitle, exact: true }) });
    await expect(conflict.getByText('Conflict', { exact: true })).toBeVisible({ timeout: 60_000 });
    await conflict.getByText('Review details', { exact: true }).click();
    await expect(conflict.getByText('Duplicate candidates')).toBeVisible();
    await expect(conflict.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    await conflict.getByRole('checkbox', { name: 'Approve the proposed values after reviewing the conflict' }).check();
    await expect(conflict.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
    expect(provider.errors).toEqual([]);
  } finally {
    await worker.close();
    await Promise.all([closeQueues(), closeRedis(), disconnectDb(), provider.close()]);
  }
});
