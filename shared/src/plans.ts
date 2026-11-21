// Plan catalogue defaults (seeded once; afterwards edited by platform admins in the database via /platform/plans).
// Entitlements are data — the API enforces them, the UI only displays them.
export interface Entitlements {
  maxUsers: number; maxWorkspaces: number; maxMailboxes: number; maxActiveCampaigns: number; maxLeads: number;
  monthlyEmailSends: number; monthlyAiUsd: number; monthlyEnrichments: number; monthlyApiCalls: number; monthlyWorkflowRuns: number; storageMb: number;
  apiRequestsPerMinute: number;
  features: { copilot: boolean; workflows: boolean; autoReply: boolean; waterfall: boolean; apiAccess: boolean; agencyWorkspaces: boolean };
  /** Integration ids a tenant may connect; ['*'] = all. */
  integrations: string[];
}
const BIG = 1_000_000_000;
export const UNLIMITED: Entitlements = {
  maxUsers: BIG, maxWorkspaces: BIG, maxMailboxes: BIG, maxActiveCampaigns: BIG, maxLeads: BIG,
  monthlyEmailSends: BIG, monthlyAiUsd: BIG, monthlyEnrichments: BIG, monthlyApiCalls: BIG, monthlyWorkflowRuns: BIG, storageMb: BIG, apiRequestsPerMinute: 100_000,
  features: { copilot: true, workflows: true, autoReply: true, waterfall: true, apiAccess: true, agencyWorkspaces: true }, integrations: ['*'],
};
/** Applied when a tenant has no usable subscription (expired trial, cancelled, suspended): read-only access only. */
export const NONE: Entitlements = {
  maxUsers: 1, maxWorkspaces: 1, maxMailboxes: 0, maxActiveCampaigns: 0, maxLeads: 0, monthlyEmailSends: 0, monthlyAiUsd: 0, monthlyEnrichments: 0, monthlyApiCalls: 0, monthlyWorkflowRuns: 0, storageMb: 0, apiRequestsPerMinute: 30,
  features: { copilot: false, workflows: false, autoReply: false, waterfall: false, apiAccess: false, agencyWorkspaces: false }, integrations: [],
};
export const DEFAULT_PLANS: Array<{ code: string; name: string; description: string; priceMonthlyCents: number; priceYearlyCents: number; currency: string; trialDays: number; sortOrder: number; entitlements: Entitlements }> = [
  { code: 'starter', name: 'Starter', description: 'For a founder or small team running focused outreach.', priceMonthlyCents: 4900, priceYearlyCents: 47000, currency: 'USD', trialDays: 14, sortOrder: 1,
    entitlements: { maxUsers: 2, maxWorkspaces: 1, maxMailboxes: 3, maxActiveCampaigns: 3, maxLeads: 5_000, monthlyEmailSends: 5_000, monthlyAiUsd: 20, monthlyEnrichments: 1_000, monthlyApiCalls: 10_000, monthlyWorkflowRuns: 0, storageMb: 1_024, apiRequestsPerMinute: 60,
      features: { copilot: true, workflows: false, autoReply: false, waterfall: false, apiAccess: false, agencyWorkspaces: false }, integrations: ['openai', 'anthropic', 'millionverifier', 'brave', 'serper'] } },
  { code: 'growth', name: 'Growth', description: 'For sales teams that need automation and more volume.', priceMonthlyCents: 14900, priceYearlyCents: 143000, currency: 'USD', trialDays: 14, sortOrder: 2,
    entitlements: { maxUsers: 5, maxWorkspaces: 3, maxMailboxes: 15, maxActiveCampaigns: 20, maxLeads: 50_000, monthlyEmailSends: 50_000, monthlyAiUsd: 100, monthlyEnrichments: 10_000, monthlyApiCalls: 100_000, monthlyWorkflowRuns: 20_000, storageMb: 10_240, apiRequestsPerMinute: 240,
      features: { copilot: true, workflows: true, autoReply: true, waterfall: true, apiAccess: true, agencyWorkspaces: false }, integrations: ['*'] } },
  { code: 'agency', name: 'Agency', description: 'For agencies running outreach for many clients, one workspace each.', priceMonthlyCents: 39900, priceYearlyCents: 383000, currency: 'USD', trialDays: 14, sortOrder: 3,
    entitlements: { maxUsers: 20, maxWorkspaces: 25, maxMailboxes: 75, maxActiveCampaigns: 100, maxLeads: 250_000, monthlyEmailSends: 250_000, monthlyAiUsd: 400, monthlyEnrichments: 50_000, monthlyApiCalls: 1_000_000, monthlyWorkflowRuns: 200_000, storageMb: 51_200, apiRequestsPerMinute: 600,
      features: { copilot: true, workflows: true, autoReply: true, waterfall: true, apiAccess: true, agencyWorkspaces: true }, integrations: ['*'] } },
];
/** Fill in any field an older plan row lacks, so plans saved before a new limit existed keep working. */
export function normalizeEntitlements(raw: Partial<Entitlements> | null | undefined, base: Entitlements = NONE): Entitlements {
  const r = raw ?? {};
  return { ...base, ...r, features: { ...base.features, ...(r.features ?? {}) }, integrations: r.integrations ?? base.integrations } as Entitlements;
}
