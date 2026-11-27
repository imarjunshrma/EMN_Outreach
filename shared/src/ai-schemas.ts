import { ImportExtractionOutput } from './knowledge-import.js';
import { z } from 'zod';

// Structured outputs for every AI task. Each model response is validated against these
// before anything is stored or acted on.

export const IcpCriteriaSchema = z.object({
  titles: z.array(z.string()).default([]),
  seniorities: z.array(z.string()).default([]),
  industries: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  countries: z.array(z.string()).default([]), // ISO alpha-2
  employeeMin: z.number().int().nullable().default(null),
  employeeMax: z.number().int().nullable().default(null),
  mustHave: z.array(z.string()).default([]),
  disqualifiers: z.array(z.string()).default([]),
});
export type IcpCriteria = z.infer<typeof IcpCriteriaSchema>;

export const IcpFromTextOutput = z.object({
  name: z.string(),
  criteria: IcpCriteriaSchema,
  assumptions: z.array(z.string()),
});

export const FactExtractionOutput = z.object({
  summary: z.string(),
  industry: z.string().nullable(),
  services: z.array(z.string()),
  audience: z.string().nullable(),
  businessModel: z.string().nullable(),
  claims: z.array(
    z.object({
      text: z.string(),
      category: z.enum(['service', 'industry', 'audience', 'business_model', 'content', 'signal', 'professional_identity', 'professional_background', 'linkedin', 'social', 'interview', 'opportunity', 'other']),
      evidenceId: z.string(),
      quote: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});
export type FactExtraction = z.infer<typeof FactExtractionOutput>;

export const QualificationOutput = z.object({
  score: z.number().int().min(0).max(100),
  reasons: z.array(
    z.object({ criterion: z.string(), met: z.boolean(), explanation: z.string(), claimIds: z.array(z.string()) }),
  ),
  risks: z.array(z.string()),
  identityAssessment: z.object({
    status: z.enum(['VERIFIED', 'AMBIGUOUS', 'MISMATCH', 'UNKNOWN']).default('UNKNOWN'),
    evidenceClaimIds: z.array(z.string()).default([]),
    reason: z.string().default(''),
  }).default({ status: 'UNKNOWN', evidenceClaimIds: [], reason: '' }),
});

export const EmailWritingOutput = z.object({
  subject: z.string().nullable(),
  firstLine: z.string().nullable(),
  body: z.string().nullable(),
  usedClaimIds: z.array(z.string()),
});

export const SubjectLinesOutput = z.object({ subjects: z.array(z.string()).min(1).max(10) });

export const FactCheckOutput = z.object({
  sentences: z.array(
    z.object({
      text: z.string(),
      verdict: z.enum(['SUPPORTED', 'GENERIC', 'UNSUPPORTED']),
      claimId: z.string().nullable(),
      reason: z.string(),
    }),
  ),
});
export type FactCheck = z.infer<typeof FactCheckOutput>;

export const ReplyCategoryValues = [
  'INTERESTED', 'WANTS_PRICING', 'WANTS_MEETING', 'NEEDS_INFO', 'NOT_INTERESTED', 'HAS_PROVIDER',
  'WRONG_PERSON', 'OUT_OF_OFFICE', 'UNSUBSCRIBE', 'COMPLAINT', 'OTHER',
] as const;

export const ReplyClassificationOutput = z.object({
  category: z.enum(ReplyCategoryValues),
  confidence: z.number().min(0).max(1),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  meetingInterest: z.boolean(),
  objection: z.string().nullable(),
  unsubscribeIntent: z.boolean(),
  isAutoReply: z.boolean(),
});
export type ReplyClassification = z.infer<typeof ReplyClassificationOutput>;

export const ConversationSummaryOutput = z.object({
  summary: z.string(),
  openQuestions: z.array(z.string()),
  suggestedNextAction: z.string(),
});

export const ReplyDraftOutput = z.object({ body: z.string(), usedClaimIds: z.array(z.string()) });

export const PersonalizationOutput = z.object({
  subject: z.string().nullable(),
  subjectAlternatives: z.array(z.string()).max(5),
  openingLine: z.string().nullable(),
  body: z.string(),
  cta: z.string().nullable(),
  usedClaimIds: z.array(z.string()),
  personalizationBasis: z.string(),
  insufficientContext: z.boolean(),
  opportunityAnalysis: z.object({
    qualification: z.enum(['STRONG_FIT', 'POSSIBLE_FIT', 'WEAK_FIT', 'INSUFFICIENT_INFORMATION']),
    businessModel: z.object({ statement: z.string().nullable(), basis: z.enum(['FACT', 'INFERENCE', 'UNKNOWN']), claimIds: z.array(z.string()) }),
    facts: z.array(z.object({ statement: z.string(), claimId: z.string() })).max(10),
    inferences: z.array(z.object({ statement: z.string(), claimIds: z.array(z.string()).min(1) })).max(10),
    unknowns: z.array(z.string()).max(10),
    opportunity: z.string().nullable(),
    serviceFit: z.string().nullable(),
    serviceVersionId: z.string().uuid().nullable().default(null),
    serviceMatchClaimIds: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1),
    missingInformation: z.array(z.string()).max(10),
    recommendedApproach: z.string().nullable(),
  }).default({ qualification: 'INSUFFICIENT_INFORMATION', businessModel: { statement: null, basis: 'UNKNOWN', claimIds: [] }, facts: [], inferences: [], unknowns: [], opportunity: null, serviceFit: null, serviceVersionId: null, serviceMatchClaimIds: [], confidence: 0, missingInformation: [], recommendedApproach: null }),
});
export type Personalization = z.infer<typeof PersonalizationOutput>;

export const COPILOT_ACTION_TYPES = ['create_campaign_draft', 'draft_sequence', 'queue_research', 'generate_reply_drafts', 'pause_campaign', 'add_memory', 'create_service_draft', 'update_prospect_title', 'queue_personalization_drafts'] as const;
export const CopilotOutput = z.object({
  answer: z.string(),
  recommendations: z.array(z.object({ title: z.string(), detail: z.string() })).max(10),
  proposedActions: z.array(z.object({ type: z.enum(COPILOT_ACTION_TYPES), summary: z.string(), params: z.array(z.object({ key: z.string(), value: z.string() })).max(12) })).max(5),
});
export type CopilotReply = z.infer<typeof CopilotOutput>;

export const AI_OUTPUT_SCHEMAS = {
  PERSONALIZATION: PersonalizationOutput,
  COPILOT: CopilotOutput,
  KNOWLEDGE_IMPORT_EXTRACTION: ImportExtractionOutput,
  ICP_FROM_TEXT: IcpFromTextOutput,
  FACT_EXTRACTION: FactExtractionOutput,
  LEAD_QUALIFICATION: QualificationOutput,
  EMAIL_WRITING: EmailWritingOutput,
  SUBJECT_LINES: SubjectLinesOutput,
  FOLLOWUP_WRITING: EmailWritingOutput,
  FACT_CHECK: FactCheckOutput,
  REPLY_CLASSIFICATION: ReplyClassificationOutput,
  CONVERSATION_SUMMARY: ConversationSummaryOutput,
  REPLY_DRAFT: ReplyDraftOutput,
} as const;

export type AiTaskName = keyof typeof AI_OUTPUT_SCHEMAS;
export const AI_TASKS = Object.keys(AI_OUTPUT_SCHEMAS) as AiTaskName[];
