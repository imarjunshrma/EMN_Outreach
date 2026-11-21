import { route } from '../http/router.js';
import * as insights from '../services/insights.js';
import * as inbox from '../services/inbox.js';

const csv = (name: string, fn: (ws: string) => Promise<string>) => async (c: { workspaceId: string; res: import('express').Response }) => {
  const body = await fn(c.workspaceId);
  c.res.setHeader('content-type', 'text/csv; charset=utf-8'); c.res.setHeader('content-disposition', `attachment; filename="${name}.csv"`); c.res.send(body);
};

route({ method: 'get', path: '/w/:workspaceId/crm/forecast', tag: 'CRM', summary: 'Weighted pipeline forecast, expected close by month, won revenue by month, win rate', auth: 'workspace', role: 'VIEWER', handler: (c) => insights.forecast(c.workspaceId) });
route({ method: 'get', path: '/w/:workspaceId/crm/opportunities/export', tag: 'CRM', summary: 'Export opportunities as CSV', auth: 'workspace', role: 'MEMBER', raw: true, handler: csv('opportunities', insights.exportOpportunitiesCsv) });
route({ method: 'get', path: '/w/:workspaceId/analytics/campaigns/export', tag: 'Analytics', summary: 'Export campaign performance as CSV', auth: 'workspace', role: 'MEMBER', raw: true, handler: csv('campaign-performance', insights.exportCampaignsCsv) });

route({ method: 'get', path: '/w/:workspaceId/saved-filters', tag: 'Saved filters', summary: 'My saved filters plus shared ones', auth: 'workspace', role: 'VIEWER', handler: (c) => insights.listSavedFilters(c.workspaceId, c.userId, typeof c.req.query.entity === 'string' ? c.req.query.entity : undefined) });
route({ method: 'post', path: '/w/:workspaceId/saved-filters', tag: 'Saved filters', summary: 'Save a filter (optionally shared with the workspace)', auth: 'workspace', role: 'VIEWER', body: insights.SavedFilterSchema, handler: (c) => insights.createSavedFilter(c.workspaceId, c.userId, c.body) });
route({ method: 'delete', path: '/w/:workspaceId/saved-filters/:id', tag: 'Saved filters', summary: 'Delete my filter (managers can delete shared filters)', auth: 'workspace', role: 'VIEWER', status: 204, handler: (c) => insights.deleteSavedFilter(c.workspaceId, c.userId, c.params.id, ['OWNER', 'ADMIN', 'MANAGER'].includes(c.role)) });

route({ method: 'get', path: '/w/:workspaceId/reports', tag: 'Reports', summary: 'Scheduled email reports', auth: 'workspace', role: 'VIEWER', handler: (c) => insights.listReports(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/reports', tag: 'Reports', summary: 'Create a scheduled report (recipients must be members)', auth: 'workspace', role: 'MANAGER', body: insights.ReportSchema, handler: (c) => insights.saveReport(c.workspaceId, null, c.body, c.actor) });
route({ method: 'put', path: '/w/:workspaceId/reports/:id', tag: 'Reports', summary: 'Update a scheduled report', auth: 'workspace', role: 'MANAGER', body: insights.ReportSchema, handler: (c) => insights.saveReport(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/reports/:id', tag: 'Reports', summary: 'Delete a scheduled report', auth: 'workspace', role: 'MANAGER', status: 204, handler: (c) => insights.deleteReport(c.workspaceId, c.params.id) });
route({ method: 'get', path: '/w/:workspaceId/reports/preview/:kind', tag: 'Reports', summary: 'Preview report text', auth: 'workspace', role: 'VIEWER', handler: async (c) => ({ text: await insights.renderReport(c.workspaceId, ['campaign_summary', 'pipeline', 'ai_cost'].includes(c.params.kind) ? c.params.kind : 'campaign_summary') }) });

route({ method: 'get', path: '/w/:workspaceId/notification-channels', tag: 'Notifications', summary: 'Slack / email notification channels (secrets never returned)', auth: 'workspace', role: 'ADMIN', handler: (c) => insights.listChannels(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/notification-channels', tag: 'Notifications', summary: 'Add a Slack incoming webhook or email channel', auth: 'workspace', role: 'ADMIN', body: insights.ChannelSchema, handler: (c) => insights.createChannel(c.workspaceId, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/notification-channels/:id', tag: 'Notifications', summary: 'Remove a channel', auth: 'workspace', role: 'ADMIN', status: 204, handler: (c) => insights.deleteChannel(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/notification-channels/test', tag: 'Notifications', summary: 'Send a test notification to all channels', auth: 'workspace', role: 'ADMIN', status: 200, rateLimit: { limit: 10, windowSec: 600, key: 'workspace' }, handler: (c) => insights.deliverToChannels(c.workspaceId, { type: '*', title: 'Test notification from EMN Outreach OS' }) });

route({ method: 'patch', path: '/w/:workspaceId/campaigns/:id/organize', tag: 'Campaigns', summary: 'Folder and tags (does not affect approval)', auth: 'workspace', role: 'MEMBER', body: insights.OrganizeSchema, handler: (c) => insights.organizeCampaign(c.workspaceId, c.params.id, c.body) });
route({ method: 'post', path: '/w/:workspaceId/conversations/:id/forward', tag: 'Inbox', summary: 'Forward a conversation from its mailbox (human action)', auth: 'workspace', role: 'MEMBER', status: 202, rateLimit: { limit: 60, windowSec: 3600, key: 'user' }, body: inbox.ForwardSchema, handler: (c) => inbox.queueForward(c.workspaceId, c.params.id, c.body, c.actor) });
