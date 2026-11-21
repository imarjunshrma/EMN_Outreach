// Mirror of shared/src/workflow.ts constants for the builder UI (kept in sync by tests/unit/frontend-sync.test.ts).
export const WORKFLOW_TRIGGERS = ['lead.created', 'lead.enriched', 'lead.scored', 'lead.status_changed', 'reply.categorized', 'email.bounced', 'lead.unsubscribed', 'meeting.booked', 'campaign.paused', 'opportunity.stage_changed', 'manual', 'schedule.daily', 'webhook.received'] as const;
export const CONDITION_FIELDS = ['lead.country', 'lead.status', 'lead.currentScore', 'lead.title', 'lead.tags', 'company.industry', 'company.employeeCount', 'event.category', 'event.campaignId', 'event.to', 'time.weekday', 'time.hour'] as const;
export const OPS = ['eq', 'neq', 'in', 'not_in', 'gte', 'lte', 'contains', 'exists'] as const;
export const ACTIONS = ['add_tag', 'update_lead_status', 'create_task', 'assign_user', 'create_opportunity', 'notify_team', 'research_lead', 'generate_reply_draft', 'pause_campaign', 'resume_campaign', 'trigger_webhook', 'export_leads'] as const;

export const ACTION_PARAMS: Record<(typeof ACTIONS)[number], Array<{ key: string; label: string; kind?: 'status' | 'campaign' | 'member' | 'role' | 'number' }>> = {
  add_tag: [{ key: 'tag', label: 'Tag' }],
  update_lead_status: [{ key: 'status', label: 'New status', kind: 'status' }],
  create_task: [{ key: 'title', label: 'Task title' }, { key: 'dueInDays', label: 'Due in days', kind: 'number' }, { key: 'assigneeId', label: 'Assignee', kind: 'member' }],
  assign_user: [{ key: 'userId', label: 'Owner', kind: 'member' }],
  create_opportunity: [{ key: 'title', label: 'Opportunity title' }, { key: 'valueCents', label: 'Value (cents)', kind: 'number' }],
  notify_team: [{ key: 'title', label: 'Message' }, { key: 'role', label: 'Minimum role', kind: 'role' }],
  research_lead: [],
  generate_reply_draft: [],
  pause_campaign: [{ key: 'campaignId', label: 'Campaign (blank = the event’s campaign)', kind: 'campaign' }],
  resume_campaign: [{ key: 'campaignId', label: 'Campaign (blank = the event’s campaign)', kind: 'campaign' }],
  trigger_webhook: [{ key: 'url', label: 'HTTPS URL' }, { key: 'secret', label: 'Signing secret (optional)' }],
  export_leads: [{ key: 'status', label: 'Only status (optional)', kind: 'status' }, { key: 'tag', label: 'Only tag (optional)' }],
};
export const ACTION_HELP: Partial<Record<(typeof ACTIONS)[number], string>> = {
  generate_reply_draft: 'Runs the reply assistant with your workspace reply mode (default: draft for human approval).',
  resume_campaign: 'Only resumes a paused campaign whose approved content is unchanged and which was not auto-paused for safety.',
  trigger_webhook: 'POSTs the event as signed JSON (X-EMN-Signature). Private/internal addresses are refused.',
};

export type Condition = { field: string; op: string; value?: string | number | string[] };
export type Block =
  | { id: string; kind: 'condition'; all: Condition[]; then: Block[]; else: Block[] }
  | { id: string; kind: 'action'; action: (typeof ACTIONS)[number]; params: Record<string, string> };

export const newId = () => Math.random().toString(36).slice(2, 10);

export const TRIGGER_LABELS: Record<(typeof WORKFLOW_TRIGGERS)[number], string> = {
  'lead.created': 'A lead is added', 'lead.enriched': 'A lead is verified or enriched', 'lead.scored': 'A lead is scored', 'lead.status_changed': 'A lead’s status changes',
  'reply.categorized': 'A reply is categorised', 'email.bounced': 'An email bounces', 'lead.unsubscribed': 'A lead unsubscribes', 'meeting.booked': 'A meeting is booked',
  'campaign.paused': 'A campaign pauses', 'opportunity.stage_changed': 'A deal changes stage', manual: 'Run manually', 'schedule.daily': 'Every day', 'webhook.received': 'An external system calls the webhook',
};
export const FIELD_LABELS: Record<(typeof CONDITION_FIELDS)[number], string> = {
  'lead.country': 'Lead country', 'lead.status': 'Lead status', 'lead.currentScore': 'Lead score', 'lead.title': 'Lead job title', 'lead.tags': 'Lead tags', 'company.industry': 'Company industry',
  'company.employeeCount': 'Company size', 'event.category': 'Reply category', 'event.campaignId': 'Campaign', 'event.to': 'New stage / status', 'time.weekday': 'Weekday (1–7)', 'time.hour': 'Hour of day',
};
export const OP_LABELS: Record<(typeof OPS)[number], string> = { eq: 'is', neq: 'is not', in: 'is one of', not_in: 'is none of', gte: '≥', lte: '≤', contains: 'contains', exists: 'has a value' };
