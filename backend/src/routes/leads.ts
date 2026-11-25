import { z } from 'zod';
import multer from 'multer';
import type { Request, Response } from 'express';
import { route, Paging, paged } from '../http/router.js';
import { BadRequest } from '../core/errors.js';
import * as leads from '../services/leads.js';
import * as intel from '../services/intelligence.js';
import * as compliance from '../services/compliance.js';
import * as crm from '../services/crm.js';
import * as ops from '../services/ops.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
function readFile(req: Request, res: Response): Promise<{ originalname: string; buffer: Buffer }> {
  return new Promise((resolve, reject) => upload.single('file')(req, res, (err) => {
    if (err) return reject(err);
    const f = (req as Request & { file?: Express.Multer.File }).file;
    if (!f) return reject(BadRequest('VALIDATION_FAILED', 'Attach a CSV file in the "file" field'));
    resolve({ originalname: f.originalname, buffer: f.buffer });
  }));
}

// ---------------------------------------------------------------- leads
route({ method: 'get', path: '/w/:workspaceId/leads', tag: 'Leads', summary: 'Search / filter leads', auth: 'workspace', role: 'VIEWER', query: leads.LeadQuerySchema,
  handler: async (c) => { const r = await leads.listLeads(c.workspaceId, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });
route({ method: 'post', path: '/w/:workspaceId/leads', tag: 'Leads', summary: 'Create a lead', auth: 'workspace', role: 'MEMBER', body: leads.LeadInputSchema, handler: (c) => leads.createLead(c.workspaceId, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/leads/export', tag: 'Leads', summary: 'Export leads as CSV (same filters as list)', auth: 'workspace', role: 'MEMBER', raw: true, query: leads.LeadQuerySchema.partial(),
  handler: async (c) => { const csv = await leads.exportLeadsCsv(c.workspaceId, c.query, c.actor); c.res.setHeader('content-type', 'text/csv; charset=utf-8'); c.res.setHeader('content-disposition', 'attachment; filename="leads.csv"'); c.res.send(csv); } });
route({ method: 'post', path: '/w/:workspaceId/leads/bulk', tag: 'Leads', summary: 'Bulk action on leads', auth: 'workspace', role: 'MEMBER', status: 200, body: leads.BulkActionSchema, handler: (c) => leads.bulkAction(c.workspaceId, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/leads/:id', tag: 'Leads', summary: 'Lead profile with history, research, scores, conversations', auth: 'workspace', role: 'VIEWER', handler: (c) => leads.getLead(c.workspaceId, c.params.id) });
route({ method: 'patch', path: '/w/:workspaceId/leads/:id', tag: 'Leads', summary: 'Update a lead (status changes are recorded)', auth: 'workspace', role: 'MEMBER', body: leads.LeadInputSchema.partial().extend({ status: z.enum(leads.LEAD_STATUSES).optional() }), handler: (c) => leads.updateLead(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/leads/:id', tag: 'Leads', summary: 'Delete a lead', auth: 'workspace', role: 'MANAGER', handler: async (c) => ({ deleted: await leads.deleteLeads(c.workspaceId, [c.params.id], c.actor) }) });
route({ method: 'post', path: '/w/:workspaceId/leads/:id/notes', tag: 'CRM', summary: 'Add a note to a lead', auth: 'workspace', role: 'MEMBER', body: z.object({ body: z.string().min(1).max(10000) }), handler: (c) => leads.addNote(c.workspaceId, { leadId: c.params.id }, c.body.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/notes/:id', tag: 'CRM', summary: 'Delete a note', auth: 'workspace', role: 'MEMBER', handler: async (c) => { await leads.deleteNote(c.workspaceId, c.params.id); return { ok: true }; } });
route({ method: 'post', path: '/w/:workspaceId/leads/:id/verify', tag: 'Leads', summary: 'Verify the lead email now (uses configured verifier)', auth: 'workspace', role: 'MEMBER', status: 200, handler: (c) => intel.verifyLead(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/leads/:id/research', tag: 'Research', summary: 'Queue research for a lead', auth: 'workspace', role: 'MEMBER', status: 202, body: z.object({ thenScore: z.boolean().default(false), refresh: z.boolean().default(false), retryMissing: z.boolean().default(false), retryReportId: z.uuid().optional(), campaignId: z.uuid().optional() }), handler: (c) => intel.queueResearch(c.workspaceId, { leadId: c.params.id, campaignId: c.body.campaignId }, c.body) });
route({ method: 'post', path: '/w/:workspaceId/leads/:id/score', tag: 'Qualification', summary: 'Score a lead against an ICP now', auth: 'workspace', role: 'MEMBER', status: 200, body: z.object({ icpId: z.string().uuid().nullable().optional() }), handler: (c) => intel.scoreLead(c.workspaceId, c.params.id, c.body.icpId) });

// ---------------------------------------------------------------- companies
route({ method: 'get', path: '/w/:workspaceId/companies', tag: 'Companies', summary: 'List companies', auth: 'workspace', role: 'VIEWER', query: Paging.extend({ q: z.string().optional() }),
  handler: async (c) => { const r = await leads.listCompanies(c.workspaceId, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });
route({ method: 'get', path: '/w/:workspaceId/companies/:id', tag: 'Companies', summary: 'Company profile', auth: 'workspace', role: 'VIEWER', handler: (c) => leads.getCompany(c.workspaceId, c.params.id) });
route({ method: 'patch', path: '/w/:workspaceId/companies/:id', tag: 'Companies', summary: 'Update a company', auth: 'workspace', role: 'MEMBER',
  body: z.object({ name: z.string().min(1).max(200), website: z.string().max(300).nullable(), industry: z.string().max(200).nullable(), employeeCount: z.number().int().min(0).nullable(), country: z.string().max(2).nullable(), city: z.string().max(100).nullable(), description: z.string().max(4000).nullable() }).partial(),
  handler: (c) => leads.updateCompany(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/companies/:id/notes', tag: 'CRM', summary: 'Add a note to a company', auth: 'workspace', role: 'MEMBER', body: z.object({ body: z.string().min(1).max(10000) }), handler: (c) => leads.addNote(c.workspaceId, { companyId: c.params.id }, c.body.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/companies/:id/research', tag: 'Research', summary: 'Queue research for a company', auth: 'workspace', role: 'MEMBER', status: 202, handler: (c) => intel.queueResearch(c.workspaceId, { companyId: c.params.id }) });

// ---------------------------------------------------------------- lists
route({ method: 'get', path: '/w/:workspaceId/lists', tag: 'Lists', summary: 'Lead lists', auth: 'workspace', role: 'VIEWER', handler: (c) => leads.listLists(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/lists', tag: 'Lists', summary: 'Create a list', auth: 'workspace', role: 'MEMBER', body: z.object({ name: z.string().min(1).max(100), description: z.string().max(500).nullable().optional() }), handler: (c) => leads.createList(c.workspaceId, c.body, c.actor) });
route({ method: 'patch', path: '/w/:workspaceId/lists/:id', tag: 'Lists', summary: 'Rename a list', auth: 'workspace', role: 'MEMBER', body: z.object({ name: z.string().min(1).max(100).optional(), description: z.string().max(500).nullable().optional() }), handler: (c) => leads.updateList(c.workspaceId, c.params.id, c.body) });
route({ method: 'delete', path: '/w/:workspaceId/lists/:id', tag: 'Lists', summary: 'Delete a list (leads are kept)', auth: 'workspace', role: 'MANAGER', handler: async (c) => { await leads.deleteList(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });

// ---------------------------------------------------------------- imports
route({ method: 'get', path: '/w/:workspaceId/imports', tag: 'Imports', summary: 'Recent CSV imports', auth: 'workspace', role: 'VIEWER', handler: (c) => leads.listImports(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/imports', tag: 'Imports', summary: 'Upload a CSV (multipart field "file"); returns headers, sample rows and suggested mapping', auth: 'workspace', role: 'MEMBER', rateLimit: { limit: 30, windowSec: 3600, key: 'workspace' },
  handler: async (c) => leads.uploadImport(c.workspaceId, await readFile(c.req, c.res), c.actor) });
route({ method: 'post', path: '/w/:workspaceId/imports/:id/start', tag: 'Imports', summary: 'Start an uploaded import with a column mapping', auth: 'workspace', role: 'MEMBER', status: 202, body: leads.StartImportSchema, handler: (c) => leads.startImport(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/imports/:id', tag: 'Imports', summary: 'Import progress and row errors', auth: 'workspace', role: 'VIEWER', handler: (c) => leads.getImport(c.workspaceId, c.params.id) });

// ---------------------------------------------------------------- suppression
route({ method: 'get', path: '/w/:workspaceId/suppressions', tag: 'Suppression', summary: 'Suppression / unsubscribe list', auth: 'workspace', role: 'VIEWER', query: Paging.extend({ q: z.string().optional(), reason: z.string().optional() }),
  handler: async (c) => { const r = await compliance.listSuppressions(c.workspaceId, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });
route({ method: 'post', path: '/w/:workspaceId/suppressions', tag: 'Suppression', summary: 'Add an email or domain to the suppression list', auth: 'workspace', role: 'MEMBER',
  body: z.object({ type: z.enum(['EMAIL', 'DOMAIN']), value: z.string().min(3).max(320), reason: z.enum(['UNSUBSCRIBED', 'DO_NOT_CONTACT_REQUEST', 'MANUAL', 'LEGAL', 'COMPLAINT']).default('MANUAL'), note: z.string().max(500).optional() }),
  handler: (c) => compliance.addSuppression(c.workspaceId, { ...c.body, source: 'manual' }, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/suppressions/import', tag: 'Suppression', summary: 'Bulk import suppressions from CSV (first column = email or @domain)', auth: 'workspace', role: 'MANAGER',
  handler: async (c) => compliance.importSuppressions(c.workspaceId, (await readFile(c.req, c.res)).buffer, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/suppressions/export', tag: 'Suppression', summary: 'Export suppression list as CSV', auth: 'workspace', role: 'MANAGER', raw: true,
  handler: async (c) => { c.res.setHeader('content-type', 'text/csv'); c.res.setHeader('content-disposition', 'attachment; filename="suppressions.csv"'); c.res.send(await ops.exportSuppressionCsv(c.workspaceId)); } });
route({ method: 'delete', path: '/w/:workspaceId/suppressions/:id', tag: 'Suppression', summary: 'Remove a suppression entry (opt-outs need a documented reason)', auth: 'workspace', role: 'ADMIN', query: z.object({ reason: z.string().default('') }),
  handler: async (c) => { await compliance.removeSuppression(c.workspaceId, c.params.id, c.query.reason, c.actor); return { ok: true }; } });

// ---------------------------------------------------------------- CRM: opportunities & tasks
route({ method: 'get', path: '/w/:workspaceId/pipeline', tag: 'CRM', summary: 'Opportunity pipeline by stage', auth: 'workspace', role: 'VIEWER', handler: (c) => crm.pipeline(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/opportunities', tag: 'CRM', summary: 'Create an opportunity', auth: 'workspace', role: 'MEMBER', body: crm.OpportunitySchema, handler: (c) => crm.createOpportunity(c.workspaceId, c.body, c.actor) });
route({ method: 'patch', path: '/w/:workspaceId/opportunities/:id', tag: 'CRM', summary: 'Update an opportunity (stage, value…)', auth: 'workspace', role: 'MEMBER', body: crm.OpportunitySchema.partial(), handler: (c) => crm.updateOpportunity(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/opportunities/:id', tag: 'CRM', summary: 'Delete an opportunity', auth: 'workspace', role: 'MANAGER', handler: async (c) => { await crm.deleteOpportunity(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/tasks', tag: 'CRM', summary: 'Tasks / follow-up reminders', auth: 'workspace', role: 'VIEWER', query: z.object({ status: z.enum(['OPEN', 'DONE', 'CANCELLED']).optional(), assigneeId: z.string().uuid().optional(), due: z.enum(['overdue', 'today', 'upcoming']).optional() }), handler: (c) => crm.listTasks(c.workspaceId, c.query) });
route({ method: 'post', path: '/w/:workspaceId/tasks', tag: 'CRM', summary: 'Create a task', auth: 'workspace', role: 'MEMBER', body: crm.TaskSchema, handler: (c) => crm.createTask(c.workspaceId, c.body, c.actor) });
route({ method: 'patch', path: '/w/:workspaceId/tasks/:id', tag: 'CRM', summary: 'Update / complete a task', auth: 'workspace', role: 'MEMBER', body: crm.TaskSchema.partial().extend({ status: z.enum(['OPEN', 'DONE', 'CANCELLED']).optional() }), handler: (c) => crm.updateTask(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/tasks/:id', tag: 'CRM', summary: 'Delete a task', auth: 'workspace', role: 'MEMBER', handler: async (c) => { await crm.deleteTask(c.workspaceId, c.params.id); return { ok: true }; } });
