import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DelayedError, Worker } from 'bullmq';
import XLSX from 'xlsx';
import JSZip from 'jszip';
import { db, disconnectDb } from '../backend/src/core/db.js';
import { QUEUES, closeQueues, queue } from '../backend/src/core/queues.js';
import { closeRedis } from '../backend/src/core/redis.js';
import { applyApproved, createImport, decideItem, importStages, recoverImportJobs } from '../backend/src/services/knowledge-import.js';
import { upsertProvider, updateRoute } from '../backend/src/services/ai.js';
import { retrieveImportedKnowledge } from '../backend/src/services/knowledge-import-apply.js';
import { processImportJob } from '../backend/src/services/knowledge-import-worker.js';

function assertIsolatedDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/outvexa_knowledge_import_acceptance');
}

async function until<T>(poll: () => Promise<T | undefined>, label: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await poll();
    if (result !== undefined) return result;
    await delay(75);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const stageWorker = (stage = 'IMPORT_FILE_PARSE', phase?: string, pauseStage = stage, workspaceIds?: string | string[], concurrency = 1) => new Worker(QUEUES.imports, async job => {
  if (!stage.split(',').includes(job.name) || (workspaceIds && ![workspaceIds].flat().includes(job.data.workspaceId))) {
    await job.moveToDelayed(Date.now() + (workspaceIds ? 150 : 120_000), job.token);
    throw new DelayedError();
  }
  if (job.name === pauseStage && phase === 'before') {
    process.send?.('checkpoint');
    await new Promise<void>(() => {});
  }
  await processImportJob(job);
  if (job.name === pauseStage && phase === 'after') {
    process.send?.('checkpoint');
    await new Promise<void>(() => {});
  }
}, { connection: { host: '127.0.0.1', port: Number(new URL(process.env.REDIS_URL!).port), maxRetriesPerRequest: null }, prefix: process.env.QUEUE_PREFIX, lockDuration: 1500, stalledInterval: 1000, concurrency });

async function child() {
  await stageWorker(process.argv[3], process.argv[4], process.argv[5], process.argv[6]).waitUntilReady();
}

async function stop(process: ChildProcess | undefined, signal: NodeJS.Signals) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  const done = once(process, 'exit');
  process.kill(signal);
  await done;
}

async function syntheticWorkspace(label: string) {
  const slug = `import-recovery-${randomUUID()}`;
  const organization = await db().organization.create({ data: { name: 'Importer recovery fixture', slug, status: 'ACTIVE' } });
  return db().workspace.create({ data: { organizationId: organization.id, slug, name: label } });
}

const files = (tag: string) => [{ originalname: 'source.txt', mimetype: 'text/plain', buffer: Buffer.from(tag) }];
const actor = { type: 'SYSTEM' as const };

async function submitWhenWorkerDies(workspaceId: string, phase: 'before' | 'after') {
  const session = await createImport(workspaceId, files(phase), actor);
  const subprocess = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, '--worker', 'IMPORT_FILE_PARSE', phase], {
    env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  try {
    const checkpoint = await Promise.race([
      once(subprocess, 'message').then(([message]) => message),
      once(subprocess, 'exit').then(() => 'worker exited'),
      delay(12_000, 'timeout', { ref: false }),
    ]);
    assert.equal(checkpoint, 'checkpoint');
  } finally {
    await stop(subprocess, 'SIGKILL');
  }
  const restarted = stageWorker();
  try {
    await restarted.waitUntilReady();
    await until(async () => {
      const row = await db().knowledgeImportSession.findUniqueOrThrow({ where: { id: session.id } });
      return row.processingStep === 'IMPORT_EXTRACTION' ? row : undefined;
    }, `${phase} crash recovery`);
    const originalJobId = `knowledge-import-${session.id}-0-IMPORT_FILE_PARSE`;
    await until(async () => (await queue(QUEUES.imports).getJob(originalJobId))?.isCompleted().then(done => done ? true : undefined), 'stalled parse delivery completion');
    const persisted = await db().knowledgeImportFile.findMany({ where: { workspaceId, sessionId: session.id } });
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].status, 'PARSED');
    assert.equal(persisted[0].content, null);
    assert.equal(await db().knowledgeImportItem.count({ where: { workspaceId, sessionId: session.id } }), 0);
    console.log(JSON.stringify({ phase, stage: 'IMPORT_FILE_PARSE', recovered: true, parsedFiles: persisted.length, applied: 0 }));
  } finally {
    await restarted.close();
  }
}

async function assertApplicationRecovery(workspaceId: string) {
  const identifier = randomUUID();
  const user = await db().user.create({ data: { email: `outvexa-crash-${identifier}@example.test`, name: 'Synthetic crash operator', passwordHash: 'login-disabled-fixture' } });
  await db().workspaceMember.create({ data: { workspaceId, userId: user.id, role: 'ADMIN' } });
  const reviewer = { type: 'USER' as const, userId: user.id };
  const session = await db().knowledgeImportSession.create({ data: { workspaceId, status: 'REVIEW' } });
  const draft = { workspaceId, sessionId: session.id, entityType: 'TARGET_AUDIENCE', destination: 'TARGET_AUDIENCE', classification: 'EXPLICIT_FACT' };
  const item = await db().knowledgeImportItem.create({ data: { ...draft, payload: { name: 'Crash recovery audience', externalId: identifier } } });
  const unapproved = await db().knowledgeImportItem.create({ data: { ...draft, payload: { name: 'Unapproved crash fixture' } } });
  await decideItem(workspaceId, item.id, { status: 'APPROVED' }, reviewer);
  await applyApproved(workspaceId, session.id, reviewer);
  const stage = 'IMPORT_APPROVED_APPLICATION';
  const subprocess = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, '--worker', stage, 'after'], {
    env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  try {
    assert.equal(await Promise.race([
      once(subprocess, 'message').then(([message]) => message),
      delay(12_000, 'timeout', { ref: false }),
    ]), 'checkpoint');
  } finally { await stop(subprocess, 'SIGKILL'); }
  const restarted = stageWorker(`${stage},IMPORT_EMBEDDING,IMPORT_RETRIEVAL_SYNC`);
  try {
    await restarted.waitUntilReady();
    const jobId = `knowledge-import-${session.id}-1-${stage}`;
    await until(async () => (await queue(QUEUES.imports).getJob(jobId))?.isCompleted().then(done => done ? true : undefined), 'stalled application completion');
    await until(async () => (await db().knowledgeImportSession.findUniqueOrThrow({ where: { id: session.id } })).status === 'APPLIED' ? true : undefined, 'final application state');
    const applied = await db().knowledgeImportItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(applied.status, 'APPLIED');
    assert.equal((await db().knowledgeImportItem.findUniqueOrThrow({ where: { id: unapproved.id } })).status, 'NEEDS_REVIEW');
    assert.equal(await db().businessKnowledgeRevision.count({ where: { workspaceId, recordId: applied.destinationEntityId! } }), 1);
    assert.equal(await db().auditLog.count({ where: { workspaceId, entityId: item.id, action: 'knowledge_import.item_applied' } }), 1);
    console.log(JSON.stringify({ phase: 'after', stage, recovered: true, revisions: 1, applicationAuditEvents: 1, unapprovedApplied: 0, finalStatus: 'APPLIED' }));
  } finally { await restarted.close(); }
}

function deferredSignal() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, resolve: release };
}

async function fixtureProvider() {
  const failures: string[] = [];
  let hold: { path: string; reached: () => void; wait: Promise<void> } | undefined;
  let requests = 0;
  let malformedNext = false;
  const server = createHttpServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input?: string[]; messages?: Array<{ content: string }> };
      requests++;
      if (malformedNext && req.url === '/v1/chat/completions') {
        malformedNext = false;
        res.end(JSON.stringify({ choices: [{ message: { content: '{"unexpected":true}' } }], usage: { prompt_tokens: 35, completion_tokens: 8 } }));
        return;
      }
      if (hold && hold.path === req.url) {
        const gate = hold;
        hold = undefined;
        gate.reached();
        await gate.wait;
      }
      if (req.url === '/v1/embeddings') {
        res.end(JSON.stringify({ data: body.input?.map((_, index) => ({ index, embedding: [1, ...Array(1535).fill(0)] })), usage: { total_tokens: 12 } }));
        return;
      }
      assert.equal(req.url, '/v1/chat/completions');
      const prompt = body.messages?.map(m => m.content).join('\n') ?? '';
      const source = /<untrusted_content source="knowledge_import">\n([\s\S]+?)\n<\/untrusted_content>/.exec(prompt)?.[1];
      assert(source);
      const items = source.split('\n\n').flatMap(fragment => {
        const [header, excerpt] = fragment.split('\n');
        const { sourceIndex, locator } = JSON.parse(header) as { sourceIndex: number; locator: string };
        if (!excerpt || !/^(document:1|.*:row-2|page-1|paragraph-1)$/.test(locator)) return [];
        return [{
          sourceIndex, entityType: 'TARGET_AUDIENCE', confidence: 0.94, classification: 'EXPLICIT_FACT',
          fields: [{ key: 'name', values: ['Synthetic controls audience'] }, { key: 'description', values: ['Synthetic audience for industrial calibration and instrument maintenance.'] }],
          sourceExcerpt: excerpt, relationships: [], mappingExplanation: 'Synthetic audience supplied by the test provider.',
        }];
      });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }], usage: { prompt_tokens: 35, completion_tokens: 15 } }));
    } catch (error) {
      failures.push((error as Error).name);
      res.statusCode = 400;
      res.end('{}');
    }
  }).listen(0, 'localhost');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    url: `http://localhost:${address.port}/v1`,
    failures,
    requestCount: () => requests,
    failNextSchema: () => { malformedNext = true; },
    pause(path: string) {
      const reached = deferredSignal();
      const wait = deferredSignal();
      hold = { path, reached: () => reached.resolve(), wait: wait.promise };
      return { reached: reached.promise, release: () => wait.resolve() };
    },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function loadDocuments() {
  const book = XLSX.utils.book_new();
  for (let sheet = 0; sheet < 4; sheet++) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['name', 'description'], ...Array.from({ length: 100 }, (_, i) => [`Synthetic entry ${i}`, 'Industrial calibration and maintenance fixtures.']),
    ]), `Load Sheet ${sheet}`);
  }
  const workbook = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const archive = new JSZip();
  archive.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  archive.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    Array.from({ length: 300 }, (_, i) => `<w:p><w:r><w:t>Entry ${i}. ${'Synthetic instrument calibration and guide. '.repeat(6)}</w:t></w:r></w:p>`).join('') +
    '</w:body></w:document>');
  const docx = await archive.generateAsync({ type: 'nodebuffer' });
  const pageCount = 120;
  const ids = Array.from({ length: pageCount }, (_, i) => 4 + 2 * i);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...ids.flatMap((id, index) => {
      const text = `BT /F1 12 Tf 20 500 Td (Synthetic instrument calibration record for page ${index + 1}) Tj ET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
        `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
      ];
    }),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const start = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return start;
  });
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;
  return [
    { originalname: 'load.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook },
    { originalname: 'load.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx },
    { originalname: 'load.pdf', mimetype: 'application/pdf', buffer: Buffer.from(pdf) },
  ];
}

async function stageMatrix(redisRestart: (whileDown?: () => Promise<void>) => Promise<void>) {
  const provider = await fixtureProvider();
  process.env.OUTVEXA_EMBEDDING_PROVIDER = 'CUSTOM_OPENAI';
  process.env.OUTVEXA_EMBEDDING_MODEL = 'import-recovery-fixture';
  process.env.ENCRYPTION_KEYS = `1:${Buffer.alloc(32, 13).toString('base64')}`;
  process.env.ENCRYPTION_ACTIVE_KEY = '1';
  const allStages = importStages.join(',');
  const output: Array<Record<string, unknown>> = [];

  async function scenario(target: string, phase: 'before' | 'after' | 'outage' | 'persisted' | 'ack' | 'repair' | 'sync-outage') {
    const workspace = await syntheticWorkspace(`Stage recovery ${target} ${phase}`);
    await upsertProvider(workspace.id, { provider: 'CUSTOM_OPENAI', apiKey: 'synthetic-fixture', baseUrl: provider.url, defaultModel: 'fixture-model' }, actor);
    await updateRoute(workspace.id, { task: 'KNOWLEDGE_IMPORT_EXTRACTION', provider: 'CUSTOM_OPENAI', model: 'fixture-model' }, actor);
    const user = await db().user.create({ data: { email: `stage-${workspace.id}@example.test`, name: 'Fixture reviewer', passwordHash: 'disabled-fixture' } });
    await db().workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'ADMIN' } });
    const reviewer = { type: 'USER' as const, userId: user.id };
    const preApproval = importStages.indexOf(target as typeof importStages[number]) < importStages.indexOf('IMPORT_APPROVED_APPLICATION');
    const session = await createImport(workspace.id, files('Synthetic imported calibration and industrial maintenance audience.'), reviewer);
    const scope = { workspaceId: workspace.id, sessionId: session.id };
    const state = () => db().knowledgeImportSession.findUniqueOrThrow({ where: { id: session.id } });
    const waitStatus = (status: string) => until(async () => (await state()).status === status ? true : undefined, status);
    const approve = async () => {
      const item = await db().knowledgeImportItem.findFirstOrThrow({ where: scope });
      await decideItem(workspace.id, item.id, { status: 'APPROVED' }, reviewer);
      await applyApproved(workspace.id, session.id, reviewer);
    };
    if (!preApproval) {
      const preparer = stageWorker(allStages, undefined, undefined, workspace.id);
      try { await waitStatus('REVIEW'); } finally { await preparer.close(); }
      await approve();
    }

    if (phase === 'sync-outage') {
      const prep = stageWorker(importStages.filter(stage => stage !== 'IMPORT_RETRIEVAL_SYNC').join(','), undefined, undefined, workspace.id);
      try {
        await until(async () => (await state()).processingStep === target ? true : undefined, 'retrieval checkpoint');
      } finally { await prep.close(); }
      const active = stageWorker(allStages, undefined, undefined, workspace.id);
      active.on('error', () => undefined);
      try {
        const jobId = `knowledge-import-${session.id}-1-${target}`;
        await db().$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "KnowledgeImportSession" WHERE "id" = ${session.id}::uuid FOR UPDATE`;
          const pending = await queue(QUEUES.imports).getJob(jobId);
          if (await pending?.isDelayed()) await pending.promote();
          await until(async () => (await queue(QUEUES.imports).getJob(jobId))?.isActive().then(running => running ? true : undefined), 'running retrieval delivery');
          await redisRestart();
        }, { timeout: 20_000 });
        await waitStatus('APPLIED');
      } finally { await active.close(); }
    } else if (phase === 'repair') {
      provider.failNextSchema();
      const gate = provider.pause('/v1/chat/completions');
      const subprocess = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, '--worker', allStages, 'running', target, workspace.id], {
        env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      try {
        assert.equal(await Promise.race([gate.reached.then(() => 'reached'), delay(12_000, 'timeout', { ref: false })]), 'reached');
        assert.equal(await db().aiExecution.count({ where: { workspaceId: workspace.id, status: 'SCHEMA_INVALID' } }), 1);
      } finally {
        await stop(subprocess, 'SIGKILL');
        gate.release();
      }
      const recovered = stageWorker(allStages, undefined, undefined, workspace.id);
      try { await waitStatus('REVIEW'); } finally { await recovered.close(); }
    } else if (phase === 'outage' || phase === 'persisted') {
      const gate = provider.pause(target === 'IMPORT_EXTRACTION' ? '/v1/chat/completions' : '/v1/embeddings');
      const working = stageWorker(allStages, undefined, undefined, workspace.id);
      working.on('error', () => undefined);
      try {
        assert.equal(await Promise.race([gate.reached.then(() => 'reached'), delay(12_000, 'timeout', { ref: false })]), 'reached');
        await redisRestart(phase === 'persisted' ? async () => {
          gate.release();
          await until(async () => await db().knowledgeImportFile.count({ where: { ...scope, status: 'EXTRACTED' } }) === 1
            ? true : undefined, 'extracted result persisted during outage');
          assert.equal((await state()).processingStep, 'IMPORT_EXTRACTION');
        } : undefined);
        gate.release();
        await waitStatus(preApproval ? 'REVIEW' : 'APPLIED');
      } finally { gate.release(); await working.close(); }
    } else {
      const before = await state();
      const subprocess = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, '--worker', allStages, phase === 'ack' ? 'after' : phase, target, workspace.id], {
        env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      try {
        assert.equal(await Promise.race([
          once(subprocess, 'message').then(([message]) => message),
          once(subprocess, 'exit').then(() => 'worker exited'),
          delay(12_000, 'timeout', { ref: false }),
        ]), 'checkpoint');
      } finally { await stop(subprocess, 'SIGKILL'); }
      if (phase === 'ack') await redisRestart();
      const recovered = stageWorker(allStages, undefined, undefined, workspace.id);
      try {
        await waitStatus(preApproval ? 'REVIEW' : 'APPLIED');
        if (phase !== 'ack') {
          const jobId = `knowledge-import-${session.id}-${before.run}-${target}`;
          await until(async () => (await queue(QUEUES.imports).getJob(jobId))?.isCompleted().then(done => done ? true : undefined), 'stalled delivery acknowledged');
        }
      } finally { await recovered.close(); }
    }

    assert.equal(await db().knowledgeImportItem.count({ where: scope }), 1);
    if (preApproval) assert.equal(await db().businessKnowledgeRecord.count({ where: { workspaceId: workspace.id } }), 0);
    const completing = stageWorker(allStages, undefined, undefined, workspace.id);
    try { if (preApproval) await approve(); await waitStatus('APPLIED'); } finally { await completing.close(); }
    const applied = await db().knowledgeImportItem.findFirstOrThrow({ where: scope });
    assert.equal(await db().businessKnowledgeRevision.count({ where: { workspaceId: workspace.id } }), 1);
    assert.equal(await db().intelligenceEmbedding.count({ where: { workspaceId: workspace.id, entityId: applied.destinationDocumentId! } }), 1);
    assert.equal(await db().auditLog.count({ where: { workspaceId: workspace.id, action: 'knowledge_import.applied', entityId: session.id } }), 1);
    assert.equal((await retrieveImportedKnowledge(workspace.id, 'industrial calibration')).length, 1);
    assert.equal((await state()).progress, 100);
    const result = { target, phase, status: 'APPLIED', revisions: 1, vectors: 1, applicationAudits: 1 };
    output.push(result);
    console.log(JSON.stringify(result));
  }

  async function fullPipelineLoad() {
    const documents = await loadDocuments();
    const tenants = await Promise.all(Array.from({ length: 3 }, async (_, index) => {
      const workspace = await syntheticWorkspace(`Full pipeline load ${index}`);
      await upsertProvider(workspace.id, { provider: 'CUSTOM_OPENAI', apiKey: 'synthetic-fixture', baseUrl: provider.url, defaultModel: 'fixture-model' }, actor);
      await updateRoute(workspace.id, { task: 'KNOWLEDGE_IMPORT_EXTRACTION', provider: 'CUSTOM_OPENAI', model: 'fixture-model' }, actor);
      const user = await db().user.create({ data: { email: `load-${workspace.id}@example.test`, name: 'Fixture load reviewer', passwordHash: 'disabled-fixture' } });
      await db().workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'ADMIN' } });
      return { workspace, reviewer: { type: 'USER' as const, userId: user.id } };
    }));
    const start = performance.now();
    const cpu = process.cpuUsage();
    const baseline = provider.requestCount();
    let rss = process.memoryUsage().rss;
    const monitor = setInterval(() => { rss = Math.max(rss, process.memoryUsage().rss); }, 50);
    const workers: Worker[] = [];
    const stageMetrics: Record<string, { completed: number; maxQueueMs: number; elapsedMs: number }> = {};
    let failedDeliveries = 0;
    try {
      const pairs = await Promise.all(tenants.map(async ({ workspace, reviewer }) => Promise.all([1, 2].map(copy =>
        createImport(workspace.id, documents, reviewer, `full-pipeline-${copy}`)))));
      for (const [first, reimport] of pairs) assert.equal(first.id, reimport.id);
      const ids = pairs.map(([session]) => session.id);
      const queuedMs = Math.round(performance.now() - start);
      const worker = stageWorker(allStages, undefined, undefined, tenants.map(tenant => tenant.workspace.id), 3);
      workers.push(worker);
      worker.on('completed', job => {
        const metric = stageMetrics[job.name] ??= { completed: 0, maxQueueMs: 0, elapsedMs: 0 };
        metric.completed++;
        metric.maxQueueMs = Math.max(metric.maxQueueMs, (job.processedOn ?? job.timestamp) - job.timestamp);
        metric.elapsedMs += (job.finishedOn ?? Date.now()) - (job.processedOn ?? Date.now());
      });
      worker.on('failed', () => { failedDeliveries++; });
      await until(async () => await db().knowledgeImportSession.count({ where: { id: { in: ids }, status: 'REVIEW' } }) === ids.length ? true : undefined, 'all load imports reviewed', 60_000);
      const reviewMs = Math.round(performance.now() - start);
      assert.equal(await db().knowledgeImportFile.count({ where: { sessionId: { in: ids }, status: 'REVIEW', error: null } }), 9);
      await Promise.all(tenants.map(async ({ workspace, reviewer }, index) => {
        const item = await db().knowledgeImportItem.findFirstOrThrow({ where: { workspaceId: workspace.id, sessionId: ids[index], status: 'CREATE' } });
        await decideItem(workspace.id, item.id, { status: 'APPROVED' }, reviewer);
        await applyApproved(workspace.id, ids[index], reviewer);
      }));
      await until(async () => await db().knowledgeImportSession.count({ where: { id: { in: ids }, status: 'APPLIED', errorSummary: null } }) === ids.length ? true : undefined, 'all load imports applied', 30_000);
      const approved = await db().knowledgeImportItem.findMany({ where: { sessionId: { in: ids }, status: 'APPLIED' } });
      assert.equal(approved.length, 3);
      assert.equal(await db().intelligenceEmbedding.count({ where: { entityId: { in: approved.map(item => item.destinationDocumentId!) } } }), 3);
      const connections = await db().$queryRaw<Array<{ count: number }>>`SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()`;
      console.log(JSON.stringify({
        fullPipeline: true, tenants: 3, submissions: 6, files: 9, approved: approved.length, embeddings: 3,
        fileBytes: Object.fromEntries(documents.map(file => [file.originalname, file.buffer.length])),
        fixtureRequests: provider.requestCount() - baseline, queuedMs, reviewMs, elapsedMs: Math.round(performance.now() - start),
        peakRssMiB: Math.round(rss / 1024 ** 2), cpuMicros: process.cpuUsage(cpu), databaseConnectionsAtEnd: connections[0]?.count,
        stages: stageMetrics, failedDeliveries,
      }));
    } finally {
      clearInterval(monitor);
      await Promise.all(workers.map(worker => worker.close()));
    }
  }

  try {
    if (process.argv.includes('--sync-only')) {
      await scenario('IMPORT_RETRIEVAL_SYNC', 'sync-outage');
    } else if (!process.argv.includes('--load-only')) {
      for (const stage of importStages.slice(1)) {
        for (const phase of ['before', 'after'] as const) await scenario(stage, phase);
      }
      await scenario('IMPORT_EXTRACTION', 'repair');
      await scenario('IMPORT_EXTRACTION', 'outage');
      await scenario('IMPORT_EXTRACTION', 'persisted');
      await scenario('IMPORT_EMBEDDING', 'outage');
      await scenario('IMPORT_RETRIEVAL_SYNC', 'ack');
      await scenario('IMPORT_RETRIEVAL_SYNC', 'sync-outage');
    }
    if (!process.argv.includes('--skip-load') && !process.argv.includes('--sync-only')) await fullPipelineLoad();
    assert.deepEqual(provider.failures, []);
    console.log(JSON.stringify({ stageScenarios: output.length, syntheticProviderRequests: provider.requestCount() }));
  } finally { await provider.close(); }
}

async function harness() {
  const scratch = await mkdtemp(join(tmpdir(), 'outvexa-import-redis-'));
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert(address && typeof address !== 'string');
  const { port } = address;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  process.env.QUEUE_PREFIX = `outvexa-import-recovery-${randomUUID()}`;
  let redisProcess: ChildProcess | undefined;
  let worker: Worker | undefined;
  async function startRedis() {
    redisProcess = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--dir', scratch, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    await until(() => new Promise<boolean | undefined>(resolve => {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(undefined));
    }), 'isolated Redis startup');
  }

  try {
    await startRedis();
    if (process.argv.includes('--stage-matrix')) {
      await stageMatrix(async (whileDown) => {
        await stop(redisProcess, 'SIGKILL');
        try { await whileDown?.(); } finally { await startRedis(); }
        await recoverImportJobs();
      });
      return;
    }
    const workspace = await syntheticWorkspace('Crash fixture');
    await submitWhenWorkerDies(workspace.id, 'before');
    await submitWhenWorkerDies(workspace.id, 'after');
    await assertApplicationRecovery(workspace.id);
    worker = stageWorker();
    let connectionErrors = 0;
    worker.on('error', () => { connectionErrors++; });
    await worker.waitUntilReady();
    await stop(redisProcess, 'SIGKILL');
    const submitStarted = performance.now();
    const outage = await createImport(workspace.id, files('Submitted during Redis outage'), actor);
    const submitMs = Math.round(performance.now() - submitStarted);
    assert.equal(outage.status, 'UPLOADED');
    assert(submitMs < 5000);
    await startRedis();
    await worker.waitUntilReady();
    await recoverImportJobs();
    await until(async () => {
      const row = await db().knowledgeImportSession.findUniqueOrThrow({ where: { id: outage.id } });
      return row.processingStep === 'IMPORT_EXTRACTION' ? row : undefined;
    }, 'outage submission recovery');
    console.log(JSON.stringify({ outage: 'Redis process killed and restarted with empty queue', submitMs, recovered: true, connectionErrors }));

    const tenants = await Promise.all(Array.from({ length: 4 }, (_, index) => syntheticWorkspace(`Load fixture ${index}`)));
    const book = XLSX.utils.book_new();
    for (let sheet = 0; sheet < 6; sheet++) {
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
        ['external_id', 'name', 'description'],
        ...Array.from({ length: 350 }, (_, i) => [`fixture-${sheet}-${i}`, `Calibration ${i}`, 'Controlled synthetic calibration and industrial measurement records. '.repeat(5)]),
      ]), `Fixture ${sheet}`);
    }
    const workbook = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const started = performance.now();
    const initialCpu = process.cpuUsage();
    let peakRss = process.memoryUsage().rss;
    const monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
    try {
      const submissions = await Promise.all(tenants.flatMap((tenant, index) => [0, 1].map(copy => createImport(tenant.id, [
        { originalname: 'fixture.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook },
        ...files(`Load workspace ${index} synthetic supplement`),
      ], actor, `load-${copy}`))));
      const uploadMs = Math.round(performance.now() - started);
      const ids = [...new Set(submissions.map(session => session.id))];
      assert.equal(ids.length, tenants.length);
      await until(async () => await db().knowledgeImportSession.count({ where: { id: { in: ids }, processingStep: 'IMPORT_EXTRACTION' } }) === ids.length
        ? true : undefined, 'load parser backlog');
      const parsed = await db().knowledgeImportFile.count({ where: { sessionId: { in: ids }, status: 'PARSED' } });
      assert.equal(parsed, 8);
      console.log(JSON.stringify({
        workload: 'concurrent service submissions through parser checkpoint',
        tenants: tenants.length, submissions: submissions.length, parsed, workbookBytes: workbook.length,
        worksheetRows: 2100, uploadMs, elapsedMs: Math.round(performance.now() - started),
        peakRssMiB: Math.round(peakRss / 1024 ** 2), processCpuMicros: process.cpuUsage(initialCpu),
      }));
    } finally { clearInterval(monitor); }
  } finally {
    await worker?.close();
    await Promise.all([closeQueues(), closeRedis(), disconnectDb()]);
    await stop(redisProcess, 'SIGTERM');
    await rm(scratch, { recursive: true, force: true });
  }
}

assertIsolatedDatabase();
if (process.argv[2] === '--worker') await child();
else await harness();
