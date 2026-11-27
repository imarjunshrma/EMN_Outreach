import { blockBrowserE2eDelivery } from '../core/browser-e2e-safety.js';
import * as warmup from '../services/warmup.js';
import { listUncertainSends, ReconciliationSchema, resolveUncertainSend } from '../services/send-reconciliation.js';
import { emptyTracking, trackingTotals } from '../services/tracking-analytics.js';
import { z } from 'zod';
import { route, Paging, paged } from '../http/router.js';
import { db } from '../core/db.js';
import { NotFound } from '../core/errors.js';
import * as engine from '../services/engine.js';
import * as accounts from '../services/accounts.js';
import * as inbox from '../services/inbox.js';
import * as analytics from '../services/analytics.js';
import * as ops from '../services/ops.js';
import * as compliance from '../services/compliance.js';
import * as automation from '../services/automation.js';
import * as webhooks from '../services/webhooks.js';
import * as leads from '../services/leads.js';
import { adapters } from '../core/container.js';
import { requireSecret } from '../services/integrations.js';

// ---------------------------------------------------------------- campaigns
route({ method: 'get', path: '/w/:workspaceId/campaigns', tag: 'Campaigns', summary: 'Campaigns with headline stats', auth: 'workspace', role: 'VIEWER', handler: (c) => engine.listCampaigns(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/campaigns', tag: 'Campaigns', summary: 'Create a campaign (DRAFT)', auth: 'workspace', role: 'MEMBER', body: engine.CampaignSettingsSchema, handler: (c) => engine.createCampaign(c.workspaceId, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/campaigns/:id', tag: 'Campaigns', summary: 'Campaign with sequence, lists and mailboxes', auth: 'workspace', role: 'VIEWER', handler: (c) => engine.getCampaign(c.workspaceId, c.params.id) });
route({ method: 'get', path: '/w/:workspaceId/campaigns/:id/activity', tag: 'Campaigns', summary: 'Campaign activity for sent messages, engagement, replies, and opt-outs', auth: 'workspace', role: 'VIEWER', query: Paging,
  handler: async (c) => {
    if (!(await db().campaign.findFirst({ where: { id: c.params.id, workspaceId: c.workspaceId }, select: { id: true } }))) throw NotFound('Campaign');
    const where = { workspaceId: c.workspaceId, campaignId: c.params.id };
    const [events, total, tracking] = await Promise.all([
      db().emailEvent.findMany({
        where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (c.query.page - 1) * c.query.pageSize, take: c.query.pageSize,
        select: { id: true, occurredAt: true, type: true, lead: { select: { id: true, email: true, firstName: true, lastName: true } }, emailAccount: { select: { emailAddress: true } } },
      }),
      db().emailEvent.count({ where }),
      trackingTotals(c.workspaceId, 'campaign', c.params.id),
    ]);
    return { ...paged(events, total, c.query.page, c.query.pageSize), lifetimeTracking: tracking.get(c.params.id) ?? emptyTracking };
  } });
route({ method: 'patch', path: '/w/:workspaceId/campaigns/:id', tag: 'Campaigns', summary: 'Update settings (invalidates approval)', auth: 'workspace', role: 'MEMBER', body: engine.CampaignSettingsSchema.partial(), handler: (c) => engine.updateCampaign(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/campaigns/:id', tag: 'Campaigns', summary: 'Delete a never-sent draft', auth: 'workspace', role: 'MANAGER', handler: async (c) => { await engine.deleteCampaign(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'put', path: '/w/:workspaceId/campaigns/:id/sequence', tag: 'Campaigns', summary: 'Save the email sequence (steps, delays, conditions, A/B variants)', auth: 'workspace', role: 'MEMBER', body: engine.SequenceSchema, handler: (c) => engine.saveSequence(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'put', path: '/w/:workspaceId/campaigns/:id/lists', tag: 'Campaigns', summary: 'Set target lead lists', auth: 'workspace', role: 'MEMBER', body: z.object({ listIds: z.array(z.string().uuid()).max(20) }), handler: async (c) => { await engine.setCampaignLists(c.workspaceId, c.params.id, c.body.listIds, c.actor); return { ok: true }; } });
route({ method: 'put', path: '/w/:workspaceId/campaigns/:id/accounts', tag: 'Campaigns', summary: 'Set sending mailboxes (each prospect gets one fixed sender)', auth: 'workspace', role: 'MEMBER', body: z.object({ accountIds: z.array(z.string().uuid()).max(50) }), handler: async (c) => { await engine.setCampaignAccounts(c.workspaceId, c.params.id, c.body.accountIds, c.actor); return { ok: true }; } });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/validate', tag: 'Campaigns', summary: 'Validate and preview eligible recipients', auth: 'workspace', role: 'MEMBER', status: 200, handler: (c) => engine.validateCampaign(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/submit', tag: 'Campaigns', summary: 'Submit for approval', auth: 'workspace', role: 'MEMBER', status: 200, handler: (c) => engine.submitCampaign(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/approve', tag: 'Campaigns', summary: 'Approve (freezes a content hash; nothing unapproved is ever sent)', auth: 'workspace', role: 'MANAGER', status: 200, handler: (c) => engine.approveCampaign(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/prepare', tag: 'Campaigns', summary: 'Activate AI preparation with email delivery disabled', auth: 'workspace', role: 'MANAGER', status: 202, handler: (c) => engine.activatePreparation(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/start', tag: 'Campaigns', summary: 'Start or resume an approved campaign', auth: 'workspace', role: 'MANAGER', status: 200, handler: (c) => engine.startCampaign(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/pause', tag: 'Campaigns', summary: 'Pause a running campaign', auth: 'workspace', role: 'MEMBER', status: 200, body: z.object({ reason: z.string().max(300).default('Paused by user') }), handler: (c) => engine.pauseCampaign(c.workspaceId, c.params.id, c.body.reason, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/archive', tag: 'Campaigns', summary: 'Archive (stops all sequences)', auth: 'workspace', role: 'MANAGER', status: 200, handler: async (c) => { await engine.archiveCampaign(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/campaigns/:id/recipients', tag: 'Campaigns', summary: 'Enrollments', auth: 'workspace', role: 'VIEWER', query: Paging.extend({ status: z.string().optional() }),
  handler: async (c) => { const r = await engine.listRecipients(c.workspaceId, c.params.id, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/enroll', tag: 'Campaigns', summary: 'Manually enroll one lead', auth: 'workspace', role: 'MEMBER', status: 200, body: z.object({ leadId: z.string().uuid() }), handler: async (c) => ({ result: await engine.enrollLeadManually(c.workspaceId, c.params.id, c.body.leadId) }) });
route({ method: 'post', path: '/w/:workspaceId/enrollments/:id/stop', tag: 'Campaigns', summary: 'Stop one prospect’s sequence', auth: 'workspace', role: 'MEMBER', status: 200, handler: async (c) => { await engine.stopEnrollment(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/campaigns/:id/steps', tag: 'Analytics', summary: 'Per-step / per-variant (A/B) performance', auth: 'workspace', role: 'VIEWER', handler: (c) => analytics.stepPerformance(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/export-smartlead', tag: 'Campaigns', summary: 'Optional: push this campaign’s eligible leads to a Smartlead campaign', auth: 'workspace', role: 'MANAGER', status: 200, body: z.object({ smartleadCampaignId: z.string().min(1) }),
  handler: async (c) => {
    blockBrowserE2eDelivery('campaign.external-export');
    const camp = await engine.getCampaign(c.workspaceId, c.params.id);
    const { secret } = await requireSecret(c.workspaceId, 'smartlead');
    const members = await db().leadListMember.findMany({ where: { workspaceId: c.workspaceId, listId: { in: camp.lists.map((l) => l.listId) } }, include: { lead: { include: { company: true } } }, distinct: ['leadId'] });
    const eligible = [];
    for (const m of members) if ((await compliance.canContact(c.workspaceId, m.lead, { requireVerified: camp.requireVerifiedEmail })).allowed) eligible.push(m.lead);
    return adapters().smartlead.addLeads(secret, c.body.smartleadCampaignId, eligible.map((l) => ({ email: l.emailNormalized, first_name: l.firstName, last_name: l.lastName, company_name: l.company?.name ?? null })));
  } });

// ---------------------------------------------------------------- outbound messages (send history / review queue)
route({ method: 'get', path: '/w/:workspaceId/outbound', tag: 'Sending', summary: 'Send history and message status', auth: 'workspace', role: 'VIEWER', query: Paging.extend({ campaignId: z.string().uuid().optional(), status: z.string().optional(), awaitingApproval: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }),
  handler: async (c) => { const r = await engine.listOutbound(c.workspaceId, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });
route({ method: 'get', path: '/w/:workspaceId/outbound-reconciliation', tag: 'Sending', summary: 'List uncertain sends for operator review', auth: 'workspace', role: 'ADMIN',
  query: Paging.extend({ resolved: z.enum(['true', 'false']).optional() }),
  handler: async c => {
    const { items, total } = await listUncertainSends(c.workspaceId, c.query.page, c.query.pageSize, c.query.resolved === 'true');
    return paged(items, total, c.query.page, c.query.pageSize);
  } });
route({ method: 'post', path: '/w/:workspaceId/outbound-reconciliation/:id', tag: 'Sending', summary: 'Record an uncertain-send decision without resending', auth: 'workspace', role: 'ADMIN', status: 200,
  body: ReconciliationSchema, handler: c => resolveUncertainSend(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/outbound/:id', tag: 'Sending', summary: 'One outbound email with fact-check report and evidence', auth: 'workspace', role: 'VIEWER', handler: (c) => engine.getOutbound(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/outbound/:id/review', tag: 'Sending', summary: 'Approve (optionally edited) or reject an email awaiting review', auth: 'workspace', role: 'MEMBER', status: 200,
  body: z.object({ decision: z.enum(['approve', 'reject']), subject: z.string().max(300).optional(), bodyText: z.string().max(20000).optional(), reason: z.string().max(300).optional() }),
  handler: (c) => engine.reviewOutbound(c.workspaceId, c.params.id, c.body, c.actor) });

// ---------------------------------------------------------------- mailboxes
route({ method: 'get', path: '/w/:workspaceId/email-accounts', tag: 'Mailboxes', summary: 'Connected mailboxes with today’s usage and health', auth: 'workspace', role: 'VIEWER', handler: (c) => accounts.listAccounts(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/email-accounts/oauth/:provider', tag: 'Mailboxes', summary: 'Start Google / Microsoft OAuth (returns the consent URL)', auth: 'workspace', role: 'ADMIN', status: 200, body: z.object({ loginHint: z.string().email().optional() }),
  handler: (c) => accounts.oauthStart(c.workspaceId, c.params.provider === 'google' ? 'GMAIL' : c.params.provider === 'microsoft' ? 'MICROSOFT' : (() => { throw NotFound('Provider'); })(), c.actor, c.body.loginHint) });
route({ method: 'post', path: '/w/:workspaceId/email-accounts/smtp', tag: 'Mailboxes', summary: 'Connect an SMTP/IMAP mailbox (only where the provider permits it)', auth: 'workspace', role: 'ADMIN', body: accounts.SmtpConnectSchema, handler: (c) => accounts.connectSmtp(c.workspaceId, c.body, c.actor) });
route({ method: 'patch', path: '/w/:workspaceId/email-accounts/:id', tag: 'Mailboxes', summary: 'Sender identity, limits and sending window', auth: 'workspace', role: 'ADMIN', body: accounts.AccountUpdateSchema, handler: (c) => accounts.updateAccount(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/email-accounts/:id/test', tag: 'Mailboxes', summary: 'Test mailbox connection', auth: 'workspace', role: 'ADMIN', status: 200, handler: (c) => accounts.testAccount(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/email-accounts/:id/delivery-diagnostic', tag: 'Mailboxes', summary: 'Send one clearly labeled diagnostic message from an authorized mailbox to itself', auth: 'workspace', role: 'ADMIN', status: 200, rateLimit: { limit: 1, windowSec: 900, key: 'workspace' }, handler: (c) => accounts.sendMailboxDiagnostic(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/email-accounts/:id/pause', tag: 'Mailboxes', summary: 'Pause sending from a mailbox', auth: 'workspace', role: 'ADMIN', status: 200, handler: (c) => accounts.setPaused(c.workspaceId, c.params.id, true, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/email-accounts/:id/resume', tag: 'Mailboxes', summary: 'Resume a paused mailbox', auth: 'workspace', role: 'ADMIN', status: 200, handler: (c) => accounts.setPaused(c.workspaceId, c.params.id, false, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/email-accounts/:id/resync', tag: 'Mailboxes', summary: 'Full resync of the mailbox', auth: 'workspace', role: 'ADMIN', status: 202, handler: (c) => accounts.resync(c.workspaceId, c.params.id, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/email-accounts/:id', tag: 'Mailboxes', summary: 'Disconnect (revokes tokens, pauses its sequences)', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await accounts.disconnectAccount(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });

// ---------------------------------------------------------------- domains
route({ method: 'get', path: '/w/:workspaceId/domains', tag: 'Deliverability', summary: 'Sending domains with latest SPF/DKIM/DMARC/MX status', auth: 'workspace', role: 'VIEWER', handler: (c) => ops.listDomains(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/domains', tag: 'Deliverability', summary: 'Add a domain (queues a DNS check)', auth: 'workspace', role: 'ADMIN', body: z.object({ name: z.string().min(3).max(253), dkimSelectors: z.array(z.string().regex(/^[a-z0-9._-]+$/i)).max(10).optional() }), handler: (c) => ops.addDomain(c.workspaceId, c.body.name, c.body.dkimSelectors, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/domains/:id', tag: 'Deliverability', summary: 'Domain check history and guidance', auth: 'workspace', role: 'VIEWER', handler: (c) => ops.getDomain(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/domains/:id/check', tag: 'Deliverability', summary: 'Run a DNS check now', auth: 'workspace', role: 'MEMBER', status: 200, rateLimit: { limit: 30, windowSec: 600, key: 'workspace' }, handler: (c) => ops.runDomainCheck(c.workspaceId, c.params.id) });
route({ method: 'delete', path: '/w/:workspaceId/domains/:id', tag: 'Deliverability', summary: 'Remove a domain', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await ops.deleteDomain(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });

// ---------------------------------------------------------------- inbox
route({ method: 'get', path: '/w/:workspaceId/conversations', tag: 'Inbox', summary: 'Unified inbox (search, filters, labels)', auth: 'workspace', role: 'VIEWER', query: inbox.ConversationQuerySchema,
  handler: async (c) => { const r = await inbox.listConversations(c.workspaceId, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });
route({ method: 'get', path: '/w/:workspaceId/conversations/:id', tag: 'Inbox', summary: 'Conversation thread, notes and lead', auth: 'workspace', role: 'VIEWER', handler: (c) => inbox.getConversation(c.workspaceId, c.params.id) });
route({ method: 'patch', path: '/w/:workspaceId/conversations/:id', tag: 'Inbox', summary: 'Read state, status, labels, assignee, category override', auth: 'workspace', role: 'MEMBER', body: inbox.ConversationUpdateSchema, handler: (c) => inbox.updateConversation(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/conversations/:id/reply', tag: 'Inbox', summary: 'Send a reply from the original mailbox (queued, idempotent)', auth: 'workspace', role: 'MEMBER', status: 202, rateLimit: { limit: 120, windowSec: 3600, key: 'user' }, body: inbox.ReplySchema, handler: (c) => inbox.queueReply(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/conversations/:id/notes', tag: 'Inbox', summary: 'Internal note on a conversation', auth: 'workspace', role: 'MEMBER', body: z.object({ body: z.string().min(1).max(10000) }), handler: (c) => leads.addNote(c.workspaceId, { conversationId: c.params.id }, c.body.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/conversations/:id/summary', tag: 'Inbox', summary: 'AI summary of the conversation', auth: 'workspace', role: 'MEMBER', status: 200, handler: (c) => inbox.summarize(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/conversations/:id/draft', tag: 'Inbox', summary: 'AI reply draft (never sent automatically)', auth: 'workspace', role: 'MEMBER', status: 200, handler: (c) => inbox.draftReply(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/messages/:id/classify', tag: 'Inbox', summary: 'Re-run AI classification for a message', auth: 'workspace', role: 'MEMBER', status: 200, handler: (c) => inbox.classifyMessage(c.workspaceId, c.params.id) });
route({ method: 'get', path: '/w/:workspaceId/attachments/:id', tag: 'Inbox', summary: 'Download an attachment', auth: 'workspace', role: 'VIEWER', raw: true,
  handler: async (c) => { const a = await inbox.downloadAttachment(c.workspaceId, c.params.id); c.res.setHeader('content-type', 'application/octet-stream'); c.res.setHeader('content-disposition', `attachment; filename="${a.filename.replace(/["\r\n]/g, '')}"`); a.stream.pipe(c.res); } });

// ---------------------------------------------------------------- analytics
route({ method: 'get', path: '/w/:workspaceId/analytics/overview', tag: 'Analytics', summary: 'Measured totals, rates and clearly-labelled estimates', auth: 'workspace', role: 'VIEWER', query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), handler: (c) => analytics.overview(c.workspaceId, c.query.days) });
route({ method: 'get', path: '/w/:workspaceId/analytics/daily', tag: 'Analytics', summary: 'Daily activity series', auth: 'workspace', role: 'VIEWER', query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), handler: (c) => analytics.daily(c.workspaceId, c.query.days) });
route({ method: 'get', path: '/w/:workspaceId/analytics/monthly', tag: 'Analytics', summary: 'Monthly activity', auth: 'workspace', role: 'VIEWER', handler: (c) => analytics.monthly(c.workspaceId) });
route({ method: 'get', path: '/w/:workspaceId/analytics/campaigns', tag: 'Analytics', summary: 'Campaign performance & attribution', auth: 'workspace', role: 'VIEWER', handler: (c) => analytics.campaignPerformance(c.workspaceId) });
route({ method: 'get', path: '/w/:workspaceId/analytics/mailboxes', tag: 'Analytics', summary: 'Mailbox performance', auth: 'workspace', role: 'VIEWER', query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), handler: (c) => analytics.mailboxPerformance(c.workspaceId, c.query.days) });
route({ method: 'get', path: '/w/:workspaceId/analytics/providers', tag: 'Analytics', summary: 'Data provider usage', auth: 'workspace', role: 'VIEWER', query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), handler: (c) => analytics.providerUsage(c.workspaceId, c.query.days) });

// ---------------------------------------------------------------- compliance
route({ method: 'get', path: '/w/:workspaceId/compliance/rules', tag: 'Compliance', summary: 'Country sending rules (technical safeguards, not legal advice)', auth: 'workspace', role: 'VIEWER', handler: (c) => compliance.listRules(c.workspaceId) });
route({ method: 'put', path: '/w/:workspaceId/compliance/rules', tag: 'Compliance', summary: 'Create/update a country rule', auth: 'workspace', role: 'ADMIN', body: compliance.RuleSchema, handler: (c) => compliance.upsertRule(c.workspaceId, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/compliance/rules/:id', tag: 'Compliance', summary: 'Delete a country rule', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await compliance.deleteRule(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/compliance/check/:leadId', tag: 'Compliance', summary: 'Explain whether a lead can be contacted now', auth: 'workspace', role: 'VIEWER',
  handler: async (c) => { const lead = await db().lead.findFirst({ where: { id: c.params.leadId, workspaceId: c.workspaceId } }); if (!lead) throw NotFound('Lead'); return compliance.canContact(c.workspaceId, lead, { requireVerified: true }); } });

// ---------------------------------------------------------------- automation & webhooks
route({ method: 'get', path: '/w/:workspaceId/automations', tag: 'Automation', summary: 'Automation rules', auth: 'workspace', role: 'VIEWER', handler: (c) => automation.listRules(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/automations', tag: 'Automation', summary: 'Create an automation rule', auth: 'workspace', role: 'MANAGER', body: automation.RuleSchema, handler: (c) => automation.createRule(c.workspaceId, c.body, c.actor) });
route({ method: 'put', path: '/w/:workspaceId/automations/:id', tag: 'Automation', summary: 'Update an automation rule', auth: 'workspace', role: 'MANAGER', body: automation.RuleSchema, handler: (c) => automation.updateRule(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/automations/:id', tag: 'Automation', summary: 'Delete an automation rule', auth: 'workspace', role: 'MANAGER', handler: async (c) => { await automation.deleteRule(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/automations/runs', tag: 'Automation', summary: 'Automation run history', auth: 'workspace', role: 'VIEWER', query: z.object({ ruleId: z.string().uuid().optional() }), handler: (c) => automation.listRuns(c.workspaceId, c.query.ruleId) });
route({ method: 'get', path: '/w/:workspaceId/webhooks', tag: 'Webhooks', summary: 'Outbound webhooks', auth: 'workspace', role: 'ADMIN', handler: async (c) => ({ webhooks: await webhooks.listWebhooks(c.workspaceId), events: automation.WEBHOOK_EVENTS }) });
route({ method: 'post', path: '/w/:workspaceId/webhooks', tag: 'Webhooks', summary: 'Create a webhook (signing secret shown once)', auth: 'workspace', role: 'ADMIN', body: webhooks.WebhookSchema, handler: (c) => webhooks.createWebhook(c.workspaceId, c.body, c.actor) });
route({ method: 'put', path: '/w/:workspaceId/webhooks/:id', tag: 'Webhooks', summary: 'Update a webhook', auth: 'workspace', role: 'ADMIN', body: webhooks.WebhookSchema, handler: (c) => webhooks.updateWebhook(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/webhooks/:id', tag: 'Webhooks', summary: 'Delete a webhook', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await webhooks.deleteWebhook(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'post', path: '/w/:workspaceId/webhooks/:id/test', tag: 'Webhooks', summary: 'Send a test delivery', auth: 'workspace', role: 'ADMIN', status: 202, handler: (c) => webhooks.sendTest(c.workspaceId, c.params.id) });
route({ method: 'get', path: '/w/:workspaceId/webhooks/:id/deliveries', tag: 'Webhooks', summary: 'Recent deliveries', auth: 'workspace', role: 'ADMIN', handler: (c) => webhooks.listDeliveries(c.workspaceId, c.params.id) });

route({ method: 'get', path: '/w/:workspaceId/warmup', tag: 'Mailboxes', summary: 'Warm-up overview', auth: 'workspace', role: 'ADMIN', handler: c => warmup.warmupOverview(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/warmup/mailboxes/:id', tag: 'Mailboxes', summary: 'Enroll a mailbox for controlled warm-up', auth: 'workspace', role: 'ADMIN', body: warmup.WarmupConfig, handler: c => warmup.enrollWarmup(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/warmup/:id', tag: 'Mailboxes', summary: 'Warm-up program and activity', auth: 'workspace', role: 'ADMIN', handler: c => warmup.warmupDetail(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/warmup/:id/actions', tag: 'Mailboxes', summary: 'Change warm-up lifecycle', auth: 'workspace', role: 'ADMIN', body: warmup.WarmupAction, handler: c => warmup.changeWarmup(c.workspaceId, c.params.id, c.body.action, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/warmup/:id/recipients', tag: 'Mailboxes', summary: 'Authorize controlled warm-up recipients', auth: 'workspace', role: 'ADMIN', body: warmup.WarmupRecipients, handler: c => warmup.addWarmupRecipients(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/warmup/:id/recipients/:recipientId', tag: 'Mailboxes', summary: 'Withdraw warm-up recipient authorization', auth: 'workspace', role: 'ADMIN', handler: c => warmup.revokeWarmupRecipient(c.workspaceId, c.params.id, c.params.recipientId, c.actor) });

route({ method: 'post', path: '/w/:workspaceId/warmup/:id/messages/:messageId/reconcile', tag: 'Mailboxes', summary: 'Review an ambiguous warm-up submission without resending', auth: 'workspace', role: 'ADMIN', body: ReconciliationSchema, handler: c => warmup.resolveWarmupSubmission(c.workspaceId, c.params.id, c.params.messageId, c.actor, c.body) });

route({ method: 'patch', path: '/w/:workspaceId/warmup/:id', tag: 'Mailboxes', summary: 'Edit a warm-up program before it starts', auth: 'workspace', role: 'ADMIN', body: warmup.WarmupConfig, handler: c => warmup.updateWarmupConfig(c.workspaceId, c.params.id, c.body, c.actor) });
