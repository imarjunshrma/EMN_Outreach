import { z } from 'zod';
import { route, Paging, paged } from '../http/router.js';
import * as intel from '../services/intelligence.js';
import * as ai from '../services/ai.js';
import * as aiSource from '../services/ai-source.js';
import * as integrations from '../services/integrations.js';
import { AI_TASKS, type AiTaskName } from '../../../shared/src/ai-schemas.js';
import { AI_PROVIDER_NAMES } from '../../../integrations/src/ai/types.js';

const TaskEnum = z.enum(AI_TASKS as [AiTaskName, ...AiTaskName[]]);

// ---------------------------------------------------------------- ICP
route({ method: 'get', path: '/w/:workspaceId/icps', tag: 'ICP', summary: 'Ideal customer profiles', auth: 'workspace', role: 'VIEWER', handler: (c) => intel.listIcps(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/icps', tag: 'ICP', summary: 'Create an ICP', auth: 'workspace', role: 'MANAGER', body: intel.IcpSchema, handler: (c) => intel.createIcp(c.workspaceId, c.body, c.actor) });
route({ method: 'put', path: '/w/:workspaceId/icps/:id', tag: 'ICP', summary: 'Update an ICP', auth: 'workspace', role: 'MANAGER', body: intel.IcpSchema, handler: (c) => intel.updateIcp(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/icps/:id', tag: 'ICP', summary: 'Delete an ICP', auth: 'workspace', role: 'MANAGER', handler: async (c) => { await intel.deleteIcp(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'post', path: '/w/:workspaceId/icps/from-text', tag: 'ICP', summary: 'Convert a natural-language description into structured ICP filters (AI draft)', auth: 'workspace', role: 'MEMBER', status: 200, rateLimit: { limit: 30, windowSec: 3600, key: 'workspace' },
  body: z.object({ description: z.string().min(10).max(4000) }), handler: (c) => intel.icpFromText(c.workspaceId, c.body.description) });

// ---------------------------------------------------------------- prospecting
route({ method: 'post', path: '/w/:workspaceId/prospecting/search', tag: 'Prospecting', summary: 'Search the configured licensed data provider', auth: 'workspace', role: 'MEMBER', status: 200, rateLimit: { limit: 60, windowSec: 3600, key: 'workspace' }, body: intel.ProspectSearchSchema, handler: (c) => intel.searchProspects(c.workspaceId, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/prospecting/import', tag: 'Prospecting', summary: 'Import selected search results (enrich, dedupe, verify, research, score)', auth: 'workspace', role: 'MEMBER', status: 200, body: intel.ProspectImportSchema, handler: (c) => intel.importProspects(c.workspaceId, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/prospecting/searches', tag: 'Prospecting', summary: 'Recent searches', auth: 'workspace', role: 'VIEWER', handler: (c) => intel.listSearches(c.workspaceId) });
route({ method: 'get', path: '/w/:workspaceId/prospecting/searches/:id', tag: 'Prospecting', summary: 'Search results', auth: 'workspace', role: 'VIEWER', handler: (c) => intel.getSearch(c.workspaceId, c.params.id) });

// ---------------------------------------------------------------- research
route({ method: 'get', path: '/w/:workspaceId/research', tag: 'Research', summary: 'Research reports', auth: 'workspace', role: 'VIEWER', query: Paging.extend({ status: z.string().optional() }),
  handler: async (c) => { const r = await intel.listReports(c.workspaceId, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });
route({ method: 'get', path: '/w/:workspaceId/research/:id', tag: 'Research', summary: 'Report with claims and evidence URLs', auth: 'workspace', role: 'VIEWER', handler: (c) => intel.getReport(c.workspaceId, c.params.id) });
route({ method: 'patch', path: '/w/:workspaceId/research/claims/:id', tag: 'Research', summary: 'Reject / restore a claim (rejected claims are never used in emails)', auth: 'workspace', role: 'MEMBER', body: z.object({ status: z.enum(['SUPPORTED', 'REJECTED']) }),
  handler: async (c) => { await intel.setClaimStatus(c.workspaceId, c.params.id, c.body.status, c.actor); return { ok: true }; } });

// ---------------------------------------------------------------- writing studio
route({ method: 'post', path: '/w/:workspaceId/writing/generate', tag: 'Writing', summary: 'Generate an evidence-backed email draft + fact-check', auth: 'workspace', role: 'MEMBER', status: 200, rateLimit: { limit: 120, windowSec: 3600, key: 'workspace' }, body: intel.GenerateSchema, handler: (c) => intel.generateEmail(c.workspaceId, c.body) });
route({ method: 'post', path: '/w/:workspaceId/writing/subjects', tag: 'Writing', summary: 'Subject line suggestions', auth: 'workspace', role: 'MEMBER', status: 200, body: z.object({ leadId: z.string().uuid(), body: z.string().min(1).max(8000), count: z.number().int().min(1).max(10).default(5) }), handler: async (c) => ({ subjects: await intel.subjectLines(c.workspaceId, c.body.leadId, c.body.body, c.body.count) }) });
route({ method: 'post', path: '/w/:workspaceId/writing/fact-check', tag: 'Writing', summary: 'Fact-check any draft against the lead’s supported claims', auth: 'workspace', role: 'MEMBER', status: 200, body: z.object({ leadId: z.string().uuid(), text: z.string().min(1).max(10000) }),
  handler: async (c) => { const { getWorkspace } = await import('../services/workspace.js'); return intel.factCheck(c.workspaceId, c.body.leadId, c.body.text, (await getWorkspace(c.workspaceId)).settings.offerFacts); } });

// ---------------------------------------------------------------- AI configuration
route({ method: 'get', path: '/w/:workspaceId/ai/source', tag: 'AI', summary: 'Where AI runs for this workspace (API keys or a Claude / Codex subscription) and which options you can choose', auth: 'workspace', role: 'VIEWER', handler: (c) => aiSource.getAiSource(c.workspaceId, c.userId || null) });
route({ method: 'put', path: '/w/:workspaceId/ai/source', tag: 'AI', summary: 'Choose where AI runs for every AI feature in this workspace. A subscription uses your own login.', auth: 'workspace', role: 'ADMIN', body: aiSource.SetAiSourceSchema, handler: (c) => aiSource.setAiSource(c.workspaceId, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/ai/providers', tag: 'AI', summary: 'Configured AI providers (key shown as last 4 only)', auth: 'workspace', role: 'ADMIN', handler: async (c) => ({ providers: await ai.listProviders(c.workspaceId), suggestions: ai.SUGGESTED_MODELS, defaultProvider: await ai.getDefaultProvider(c.workspaceId) }) });
route({ method: 'put', path: '/w/:workspaceId/ai/providers', tag: 'AI', summary: 'Add/update an AI provider key and default model', auth: 'workspace', role: 'ADMIN',
  body: z.object({ provider: z.enum(AI_PROVIDER_NAMES), apiKey: z.string().min(1).max(500).optional(), defaultModel: z.string().min(1).max(150), baseUrl: z.string().max(500).nullable().optional(), isEnabled: z.boolean().optional() }),
  handler: (c) => ai.upsertProvider(c.workspaceId, c.body, c.actor) });
route({ method: 'put', path: '/w/:workspaceId/ai/default-provider', tag: 'AI', summary: 'Set the workspace default AI provider and optionally apply it to all task routes', auth: 'workspace', role: 'ADMIN', body: ai.SetDefaultProviderSchema, handler: (c) => ai.setDefaultProvider(c.workspaceId, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/ai/providers/:provider', tag: 'AI', summary: 'Remove an AI provider', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await ai.deleteProvider(c.workspaceId, z.enum(AI_PROVIDER_NAMES).parse(c.params.provider), c.actor); return { ok: true }; } });
route({ method: 'post', path: '/w/:workspaceId/ai/providers/:provider/test', tag: 'AI', summary: 'Test an AI provider connection', auth: 'workspace', role: 'ADMIN', status: 200, rateLimit: { limit: 20, windowSec: 600, key: 'workspace' }, handler: (c) => ai.testProvider(c.workspaceId, z.enum(AI_PROVIDER_NAMES).parse(c.params.provider)) });
route({ method: 'get', path: '/w/:workspaceId/ai/providers/:provider/models', tag: 'AI', summary: 'List models available to a configured provider', auth: 'workspace', role: 'ADMIN', rateLimit: { limit: 30, windowSec: 600, key: 'workspace' }, handler: (c) => ai.providerModels(c.workspaceId, z.enum(AI_PROVIDER_NAMES).parse(c.params.provider)) });
route({ method: 'get', path: '/w/:workspaceId/ai/routes', tag: 'AI', summary: 'Model routing per task', auth: 'workspace', role: 'ADMIN', handler: (c) => ai.listRoutes(c.workspaceId) });
route({ method: 'put', path: '/w/:workspaceId/ai/routes', tag: 'AI', summary: 'Set model, fallback and budget for a task', auth: 'workspace', role: 'ADMIN', body: ai.RouteUpdateSchema, handler: (c) => ai.updateRoute(c.workspaceId, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/ai/prompts', tag: 'AI', summary: 'Prompt versions', auth: 'workspace', role: 'ADMIN', query: z.object({ task: TaskEnum.optional() }), handler: (c) => ai.listPrompts(c.workspaceId, c.query.task) });
route({ method: 'post', path: '/w/:workspaceId/ai/prompts', tag: 'AI', summary: 'Create a new prompt version (immutable history)', auth: 'workspace', role: 'ADMIN',
  body: z.object({ task: TaskEnum, systemPrompt: z.string().min(20).max(20000), userPromptTemplate: z.string().min(5).max(20000), changeNote: z.string().max(300).optional(), activate: z.boolean().default(false) }),
  handler: (c) => ai.createPromptVersion(c.workspaceId, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai/prompts/:id/activate', tag: 'AI', summary: 'Activate a prompt version', auth: 'workspace', role: 'ADMIN', status: 200, handler: async (c) => { await ai.activatePrompt(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/ai/usage', tag: 'AI', summary: 'Token usage and estimated cost', auth: 'workspace', role: 'MANAGER', query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), handler: (c) => ai.usageReport(c.workspaceId, c.query.days) });
route({ method: 'get', path: '/w/:workspaceId/ai/executions', tag: 'AI', summary: 'AI response logs', auth: 'workspace', role: 'ADMIN', query: Paging.extend({ task: TaskEnum.optional(), status: z.string().optional() }),
  handler: async (c) => { const r = await ai.listExecutions(c.workspaceId, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });
route({ method: 'get', path: '/w/:workspaceId/ai/prices', tag: 'AI', summary: 'Model price table (USD per million tokens)', auth: 'workspace', role: 'ADMIN', handler: () => ai.listPrices() });
route({ method: 'post', path: '/w/:workspaceId/ai/prices', tag: 'AI', summary: 'Add a model price (owner only; applies to cost estimates)', auth: 'workspace', role: 'OWNER',
  body: z.object({ provider: z.enum(AI_PROVIDER_NAMES), model: z.string().min(1).max(150), inputPerMTokUsd: z.number().min(0), outputPerMTokUsd: z.number().min(0), cachedInputPerMTokUsd: z.number().min(0).nullable().optional() }),
  handler: (c) => ai.upsertPrice(c.body, c.actor) });

// ---------------------------------------------------------------- provider integrations
route({ method: 'get', path: '/w/:workspaceId/integrations', tag: 'Integrations', summary: 'Provider integrations (secrets never returned)', auth: 'workspace', role: 'ADMIN', handler: (c) => integrations.listIntegrations(c.workspaceId) });
route({ method: 'put', path: '/w/:workspaceId/integrations', tag: 'Integrations', summary: 'Set provider key / config', auth: 'workspace', role: 'ADMIN', body: integrations.IntegrationUpsertSchema, handler: (c) => integrations.upsertIntegration(c.workspaceId, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/integrations/:type', tag: 'Integrations', summary: 'Remove a provider integration', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await integrations.deleteIntegration(c.workspaceId, z.enum(integrations.INTEGRATION_TYPES).parse(c.params.type), c.actor); return { ok: true }; } });
route({ method: 'post', path: '/w/:workspaceId/integrations/:type/test', tag: 'Integrations', summary: 'Test a provider integration', auth: 'workspace', role: 'ADMIN', status: 200, rateLimit: { limit: 20, windowSec: 600, key: 'workspace' }, handler: (c) => integrations.testIntegration(c.workspaceId, z.enum(integrations.INTEGRATION_TYPES).parse(c.params.type)) });
