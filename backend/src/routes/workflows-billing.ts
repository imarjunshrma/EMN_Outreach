import { z } from 'zod';
import { route } from '../http/router.js';
import * as wf from '../services/workflows.js';
import * as billing from '../services/billing.js';
import { db } from '../core/db.js';

// ---------------- Visual workflow builder
route({ method: 'get', path: '/w/:workspaceId/workflows', tag: 'Workflows', summary: 'List workflows', auth: 'workspace', role: 'VIEWER', handler: (c) => wf.listWorkflows(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/workflows', tag: 'Workflows', summary: 'Create a workflow (version 1)', auth: 'workspace', role: 'MANAGER', body: wf.WorkflowSchema, handler: (c) => wf.saveWorkflow(c.workspaceId, null, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/workflows/:id', tag: 'Workflows', summary: 'Workflow with all versions', auth: 'workspace', role: 'VIEWER', handler: (c) => wf.getWorkflow(c.workspaceId, c.params.id) });
route({ method: 'put', path: '/w/:workspaceId/workflows/:id', tag: 'Workflows', summary: 'Save a new version (becomes active version)', auth: 'workspace', role: 'MANAGER', body: wf.WorkflowSchema, handler: (c) => wf.saveWorkflow(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/workflows/:id', tag: 'Workflows', summary: 'Delete a workflow', auth: 'workspace', role: 'MANAGER', status: 204, handler: (c) => wf.deleteWorkflow(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/workflows/:id/active', tag: 'Workflows', summary: 'Activate / deactivate', auth: 'workspace', role: 'MANAGER', status: 200, body: z.object({ active: z.boolean() }), handler: async (c) => { await wf.setActive(c.workspaceId, c.params.id, c.body.active, c.actor); return { ok: true }; } });
route({ method: 'post', path: '/w/:workspaceId/workflows/:id/versions/:versionId/restore', tag: 'Workflows', summary: 'Make an older version active', auth: 'workspace', role: 'MANAGER', status: 200, handler: async (c) => { await wf.restoreVersion(c.workspaceId, c.params.id, c.params.versionId, c.actor); return { ok: true }; } });
route({ method: 'post', path: '/w/:workspaceId/workflows/:id/run', tag: 'Workflows', summary: 'Run now (testMode=true is a dry run that changes nothing)', auth: 'workspace', role: 'MANAGER', status: 200, rateLimit: { limit: 60, windowSec: 600, key: 'workspace' }, body: z.object({ testMode: z.boolean().default(true), payload: z.record(z.string(), z.unknown()).default({}) }), handler: (c) => wf.triggerManual(c.workspaceId, c.params.id, c.body.payload, c.body.testMode, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/workflows/:id/runs', tag: 'Workflows', summary: 'Execution history with per-block log', auth: 'workspace', role: 'VIEWER', handler: (c) => wf.listRuns(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/workflows/:id/webhook-token', tag: 'Workflows', summary: 'Rotate the inbound webhook token (shown once)', auth: 'workspace', role: 'ADMIN', status: 200, handler: (c) => wf.webhookToken(c.workspaceId, c.params.id, c.actor) });

// ---------------- Billing (workspace shortcut). Full billing lives under /orgs/:organizationId/billing.
route({ method: 'get', path: '/w/:workspaceId/billing', tag: 'Billing', summary: 'Plan, status, usage and (for owners/billing managers) invoices of this workspace\'s organization', auth: 'workspace', role: 'VIEWER', allowWhenInactive: true,
  handler: async (c) => {
    const m = await db().organizationMember.findUnique({ where: { organizationId_userId: { organizationId: c.organizationId, userId: c.userId } } });
    const canBill = m?.role === 'OWNER' || m?.role === 'BILLING';
    return { organizationId: c.organizationId, ...(await billing.overview(c.organizationId, { includeInvoices: canBill })) };
  } });
