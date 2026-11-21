import { z } from 'zod';

// Visual workflow graph: an ordered list of blocks; condition blocks contain "then" and "else" branches.
// Pure validation + condition evaluation (shared by API, worker and the builder UI).

export const WORKFLOW_TRIGGERS = ['lead.created', 'lead.enriched', 'lead.scored', 'lead.status_changed', 'reply.categorized', 'email.bounced', 'lead.unsubscribed', 'meeting.booked', 'campaign.paused', 'opportunity.stage_changed', 'manual', 'schedule.daily', 'webhook.received'] as const;
export const CONDITION_FIELDS = ['lead.country', 'lead.status', 'lead.currentScore', 'lead.title', 'lead.tags', 'company.industry', 'company.employeeCount', 'event.category', 'event.campaignId', 'event.to', 'time.weekday', 'time.hour'] as const;
export const OPS = ['eq', 'neq', 'in', 'not_in', 'gte', 'lte', 'contains', 'exists'] as const;
export const ACTIONS = ['add_tag', 'update_lead_status', 'create_task', 'assign_user', 'create_opportunity', 'notify_team', 'research_lead', 'generate_reply_draft', 'pause_campaign', 'resume_campaign', 'trigger_webhook', 'export_leads'] as const;

export const ConditionSchema = z.object({
  field: z.union([z.enum(CONDITION_FIELDS), z.string().regex(/^lead\.custom\.[a-zA-Z0-9_]{1,40}$/)]),
  op: z.enum(OPS),
  value: z.union([z.string().max(200), z.number(), z.array(z.string().max(100)).max(50)]).optional(),
});

export type Block =
  | { id: string; kind: 'condition'; all: Array<z.infer<typeof ConditionSchema>>; then: Block[]; else: Block[] }
  | { id: string; kind: 'action'; action: (typeof ACTIONS)[number]; params: Record<string, string> };

export const BlockSchema: z.ZodType<Block> = z.lazy(() => z.union([
  z.object({ id: z.string().min(1).max(40), kind: z.literal('condition'), all: z.array(ConditionSchema).min(1).max(10), then: z.array(BlockSchema).max(20), else: z.array(BlockSchema).max(20) }),
  z.object({ id: z.string().min(1).max(40), kind: z.literal('action'), action: z.enum(ACTIONS), params: z.record(z.string(), z.string().max(2000)) }),
]));

export const GraphSchema = z.object({ blocks: z.array(BlockSchema).min(1).max(30) }).superRefine((g, ctx) => {
  let count = 0;
  const walk = (bs: Block[], depth: number) => {
    if (depth > 4) ctx.addIssue({ code: 'custom', message: 'Branches can be nested at most 4 levels deep' });
    for (const b of bs) { count++; if (b.kind === 'condition') { walk(b.then, depth + 1); walk(b.else, depth + 1); } }
  };
  walk(g.blocks, 1);
  if (count > 60) ctx.addIssue({ code: 'custom', message: 'A workflow can have at most 60 blocks' });
});
export type Graph = z.infer<typeof GraphSchema>;

function get(ctx: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined), ctx);
}

export function evalCondition(c: z.infer<typeof ConditionSchema>, ctx: Record<string, unknown>): boolean {
  const v = get(ctx, c.field);
  const val = c.value;
  const list = Array.isArray(val) ? val.map(String) : val === undefined ? [] : [String(val)];
  switch (c.op) {
    case 'exists': return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
    case 'eq': return String(v ?? '') === String(val ?? '');
    case 'neq': return String(v ?? '') !== String(val ?? '');
    case 'in': return Array.isArray(v) ? v.some((x) => list.includes(String(x))) : list.includes(String(v ?? ''));
    case 'not_in': return Array.isArray(v) ? !v.some((x) => list.includes(String(x))) : !list.includes(String(v ?? ''));
    case 'gte': return v !== null && v !== undefined && Number(v) >= Number(val);
    case 'lte': return v !== null && v !== undefined && Number(v) <= Number(val);
    case 'contains': return Array.isArray(v) ? v.map(String).includes(String(val)) : String(v ?? '').toLowerCase().includes(String(val ?? '').toLowerCase());
  }
}
