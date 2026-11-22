import { z } from 'zod';
import { route, Paging, paged } from '../http/router.js';
import * as subs from '../services/ai-subscriptions.js';
import * as wf from '../services/ai-workflows.js';
import * as runs from '../services/ai-workflow-runs.js';
import { SUBSCRIPTION_PROVIDERS } from '../../../shared/src/ai-workflows.js';

// Personal AI subscriptions, workflow builder, writing playbook and owner-only generation.
// Every route except /ai-subscriptions/access is aiOwnerOnly (404 for everyone else, enforced server-side).

const Provider = z.enum(SUBSCRIPTION_PROVIDERS);
const tag = 'AI subscriptions';
const prov = (p: string) => Provider.parse(p);

route({ method: 'get', path: '/ai-subscriptions/access', tag, summary: 'Whether the signed-in user may use personal AI subscriptions', auth: 'user', handler: async (c) => ({ allowed: await subs.isAiSubscriptionOwner(c.userId) }) });

// ---- connections
route({ method: 'get', path: '/ai-subscriptions/connections', tag, summary: 'Subscription connection status (no credentials are returned)', auth: 'user', aiOwnerOnly: true, handler: async (c) => ({ connections: await subs.listConnections(c.userId) }) });
route({ method: 'post', path: '/ai-subscriptions/claude/connect', tag, summary: 'Connect Claude with a token from `claude setup-token`', auth: 'user', aiOwnerOnly: true, status: 200, body: subs.ClaudeConnectSchema, rateLimit: { limit: 10, windowSec: 3600, key: 'user' }, handler: (c) => subs.connectClaude(c.userId, c.body.token, c.req.ip ?? null) });
route({ method: 'post', path: '/ai-subscriptions/codex/login', tag, summary: 'Start Codex ChatGPT sign-in (device code)', auth: 'user', aiOwnerOnly: true, status: 200, rateLimit: { limit: 10, windowSec: 3600, key: 'user' }, handler: (c) => subs.startCodexLogin(c.userId, c.req.ip ?? null) });
route({ method: 'get', path: '/ai-subscriptions/codex/login', tag, summary: 'Codex sign-in progress', auth: 'user', aiOwnerOnly: true, handler: (c) => subs.codexLoginStatus(c.userId) });
route({ method: 'delete', path: '/ai-subscriptions/codex/login', tag, summary: 'Cancel a pending Codex sign-in', auth: 'user', aiOwnerOnly: true, handler: (c) => subs.cancelCodexLogin(c.userId) });
route({ method: 'post', path: '/ai-subscriptions/:provider/test', tag, summary: 'Test a subscription connection with a minimal real request', auth: 'user', aiOwnerOnly: true, status: 200, rateLimit: { limit: 20, windowSec: 3600, key: 'user' }, handler: (c) => subs.testConnection(c.userId, prov(c.params.provider)) });
route({ method: 'put', path: '/ai-subscriptions/:provider/settings', tag, summary: 'Model, concurrency, delay and pause for a subscription', auth: 'user', aiOwnerOnly: true, body: subs.ConnectionSettingsSchema, handler: (c) => subs.updateSettings(c.userId, prov(c.params.provider), c.body) });
route({ method: 'delete', path: '/ai-subscriptions/:provider', tag, summary: 'Disconnect a subscription (removes the stored credential / signs Codex out)', auth: 'user', aiOwnerOnly: true, handler: (c) => subs.disconnect(c.userId, prov(c.params.provider), c.req.ip ?? null) });

// ---- workflows
route({ method: 'get', path: '/ai-workflows', tag, summary: 'List AI workflows (presets are created on first use)', auth: 'user', aiOwnerOnly: true, handler: async (c) => ({ workflows: await wf.listWorkflows(c.userId) }) });
route({ method: 'post', path: '/ai-workflows', tag, summary: 'Create a workflow', auth: 'user', aiOwnerOnly: true, body: wf.WorkflowInputSchema, handler: (c) => wf.createWorkflow(c.userId, c.body) });
route({ method: 'get', path: '/ai-workflows/:id', tag, summary: 'Get a workflow', auth: 'user', aiOwnerOnly: true, handler: (c) => wf.getWorkflow(c.userId, c.params.id) });
route({ method: 'put', path: '/ai-workflows/:id', tag, summary: 'Update a workflow (stages, order, providers, instructions)', auth: 'user', aiOwnerOnly: true, body: wf.WorkflowInputSchema, handler: (c) => wf.updateWorkflow(c.userId, c.params.id, c.body) });
route({ method: 'delete', path: '/ai-workflows/:id', tag, summary: 'Delete a workflow', auth: 'user', aiOwnerOnly: true, handler: (c) => wf.deleteWorkflow(c.userId, c.params.id) });
route({ method: 'post', path: '/ai-workflows/:id/duplicate', tag, summary: 'Duplicate a workflow', auth: 'user', aiOwnerOnly: true, handler: (c) => wf.duplicateWorkflow(c.userId, c.params.id) });
route({ method: 'post', path: '/ai-workflows/:id/activate', tag, summary: 'Make this the workflow used by "Generate with selected workflow"', auth: 'user', aiOwnerOnly: true, status: 200, handler: (c) => wf.activateWorkflow(c.userId, c.params.id) });
route({ method: 'get', path: '/ai-stage-templates', tag, summary: 'Saved stage templates', auth: 'user', aiOwnerOnly: true, handler: async (c) => ({ templates: await wf.listStageTemplates(c.userId) }) });
route({ method: 'post', path: '/ai-stage-templates', tag, summary: 'Save a stage as a reusable template', auth: 'user', aiOwnerOnly: true, body: wf.StageTemplateSchema, handler: (c) => wf.saveStageTemplate(c.userId, c.body) });
route({ method: 'delete', path: '/ai-stage-templates/:id', tag, summary: 'Delete a stage template', auth: 'user', aiOwnerOnly: true, handler: (c) => wf.deleteStageTemplate(c.userId, c.params.id) });

// ---- playbook
route({ method: 'get', path: '/ai-playbook', tag, summary: 'Current writing playbook and version history', auth: 'user', aiOwnerOnly: true, handler: (c) => wf.playbookOverview(c.userId) });
route({ method: 'get', path: '/ai-playbook/versions/:id', tag, summary: 'One playbook version', auth: 'user', aiOwnerOnly: true, handler: (c) => wf.playbookVersion(c.userId, c.params.id) });
route({ method: 'post', path: '/ai-playbook', tag, summary: 'Save the playbook as a new version', auth: 'user', aiOwnerOnly: true, body: wf.PlaybookSaveSchema, handler: (c) => wf.savePlaybook(c.userId, c.body) });
route({ method: 'post', path: '/ai-playbook/versions/:id/restore', tag, summary: 'Restore a previous playbook version (creates a new version)', auth: 'user', aiOwnerOnly: true, handler: (c) => wf.restorePlaybook(c.userId, c.params.id) });

// ---- queue control (owner-wide)
route({ method: 'post', path: '/ai-queue/pause', tag, summary: 'Pause all AI workflow queues', auth: 'user', aiOwnerOnly: true, status: 200, handler: (c) => runs.setQueuesPaused(c.userId, true) });
route({ method: 'post', path: '/ai-queue/resume', tag, summary: 'Resume all AI workflow queues', auth: 'user', aiOwnerOnly: true, status: 200, handler: (c) => runs.setQueuesPaused(c.userId, false) });

// ---- generation in a workspace (prospect / campaign)
const RunQuery = Paging.extend({ leadId: z.string().uuid().optional(), status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PAUSED', 'PAUSED_LIMIT', 'CANCELLED']).optional() });
route({ method: 'post', path: '/w/:workspaceId/ai-runs', tag, summary: 'Generate emails for a prospect with a workflow, Claude or Codex (queued; never sends)', auth: 'workspace', role: 'MEMBER', aiOwnerOnly: true, body: runs.CreateRunSchema, rateLimit: { limit: 120, windowSec: 3600, key: 'user' }, handler: (c) => runs.createRun(c.userId, c.workspaceId, c.body) });
route({ method: 'get', path: '/w/:workspaceId/ai-runs', tag, summary: 'Generation history', auth: 'workspace', aiOwnerOnly: true, query: RunQuery, handler: async (c) => { const r = await runs.listRuns(c.userId, c.workspaceId, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });
route({ method: 'get', path: '/w/:workspaceId/ai-runs/:id', tag, summary: 'Run detail: research, variants, stages and execution log', auth: 'workspace', aiOwnerOnly: true, handler: (c) => runs.getRun(c.userId, c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/ai-runs/:id/pause', tag, summary: 'Pause a run', auth: 'workspace', aiOwnerOnly: true, status: 200, handler: (c) => runs.pauseRun(c.userId, c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/ai-runs/:id/resume', tag, summary: 'Resume / retry a run, optionally choosing another provider for the paused stage', auth: 'workspace', aiOwnerOnly: true, status: 200, body: runs.ResumeSchema, handler: (c) => runs.resumeRun(c.userId, c.workspaceId, c.params.id, c.body) });
route({ method: 'post', path: '/w/:workspaceId/ai-runs/:id/cancel', tag, summary: 'Cancel a run', auth: 'workspace', aiOwnerOnly: true, status: 200, handler: (c) => runs.cancelRun(c.userId, c.workspaceId, c.params.id) });
route({ method: 'put', path: '/w/:workspaceId/ai-runs/:id/variants/:index', tag, summary: 'Edit a variant subject/body', auth: 'workspace', aiOwnerOnly: true, body: runs.EditVariantSchema, handler: (c) => runs.editVariant(c.userId, c.workspaceId, c.params.id, Number(c.params.index), c.body) });
route({ method: 'post', path: '/w/:workspaceId/ai-runs/:id/variants/:index/select', tag, summary: 'Select the preferred variant', auth: 'workspace', aiOwnerOnly: true, status: 200, handler: (c) => runs.selectVariant(c.userId, c.workspaceId, c.params.id, Number(c.params.index)) });
route({ method: 'post', path: '/w/:workspaceId/ai-runs/:id/variants/:index/regenerate', tag, summary: 'Regenerate one variant (queued)', auth: 'workspace', aiOwnerOnly: true, status: 202, handler: (c) => runs.requestRegenerateVariant(c.userId, c.workspaceId, c.params.id, Number(c.params.index)) });
route({ method: 'post', path: '/w/:workspaceId/ai-runs/:id/draft', tag, summary: 'Save the selected variant as a draft (nothing is sent)', auth: 'workspace', aiOwnerOnly: true, status: 200, body: z.object({ index: z.number().int().min(0).max(9).optional() }), handler: (c) => runs.saveDraft(c.userId, c.workspaceId, c.params.id, c.body.index) });
route({ method: 'get', path: '/w/:workspaceId/ai-queue', tag, summary: 'AI generation queue dashboard', auth: 'workspace', aiOwnerOnly: true, handler: (c) => runs.queueDashboard(c.userId, c.workspaceId) });
