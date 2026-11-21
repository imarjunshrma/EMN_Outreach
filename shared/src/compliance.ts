// Technical safeguards for recipient-country rules.
// THIS IS NOT LEGAL ADVICE. Defaults are deliberately conservative; the workspace owner must
// review each rule with a qualified advisor and tick "reviewed" before relaxing it.

export type LawfulBasisValue = 'UNKNOWN' | 'CONSENT' | 'LEGITIMATE_INTEREST' | 'EXISTING_RELATIONSHIP' | 'NOT_REQUIRED';

export interface ComplianceRuleInput {
  countryCode: string;
  label: string;
  sendingAllowed: boolean;
  allowedLawfulBases: LawfulBasisValue[];
  requirePostalAddress: boolean;
  requireUnsubscribeLink: boolean;
  notes: string;
}

export const EU_EEA = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
];

export const DEFAULT_COMPLIANCE_RULES: ComplianceRuleInput[] = [
  {
    countryCode: 'US', label: 'United States', sendingAllowed: true,
    allowedLawfulBases: ['CONSENT', 'LEGITIMATE_INTEREST', 'EXISTING_RELATIONSHIP', 'NOT_REQUIRED'],
    requirePostalAddress: true, requireUnsubscribeLink: true,
    notes: 'CAN-SPAM style safeguards: accurate headers, postal address, working opt-out honored promptly. Review state laws.',
  },
  {
    countryCode: 'GB', label: 'United Kingdom', sendingAllowed: true,
    allowedLawfulBases: ['CONSENT', 'LEGITIMATE_INTEREST'],
    requirePostalAddress: true, requireUnsubscribeLink: true,
    notes: 'UK GDPR + PECR. Corporate subscribers generally differ from individual/sole-trader addresses — review before sending. Record a lawful basis per lead.',
  },
  {
    countryCode: 'EU', label: 'EU / EEA (group)', sendingAllowed: false,
    allowedLawfulBases: ['CONSENT'],
    requirePostalAddress: true, requireUnsubscribeLink: true,
    notes: 'Restricted by default: GDPR + national ePrivacy rules vary by member state. Enable only after review.',
  },
  {
    countryCode: 'CA', label: 'Canada', sendingAllowed: false,
    allowedLawfulBases: ['CONSENT'],
    requirePostalAddress: true, requireUnsubscribeLink: true,
    notes: 'Restricted by default: CASL generally requires express or implied consent. Enable only after review.',
  },
  {
    countryCode: 'AU', label: 'Australia', sendingAllowed: false,
    allowedLawfulBases: ['CONSENT', 'EXISTING_RELATIONSHIP'],
    requirePostalAddress: true, requireUnsubscribeLink: true,
    notes: 'Restricted by default: Spam Act 2003 requires consent (express or inferred). Enable only after review.',
  },
  {
    countryCode: 'IN', label: 'India', sendingAllowed: true,
    allowedLawfulBases: ['CONSENT', 'LEGITIMATE_INTEREST', 'EXISTING_RELATIONSHIP'],
    requirePostalAddress: true, requireUnsubscribeLink: true,
    notes: 'DPDP Act 2023 obligations apply to personal data processing; record a basis and honor erasure requests.',
  },
  {
    countryCode: '*', label: 'All other / unknown countries', sendingAllowed: false,
    allowedLawfulBases: ['CONSENT'],
    requirePostalAddress: true, requireUnsubscribeLink: true,
    notes: 'Unknown recipient country is blocked until a rule exists. Set the lead country to evaluate it.',
  },
];

export interface ComplianceContext {
  country: string | null | undefined;
  lawfulBasis: LawfulBasisValue;
  workspaceHasPostalAddress: boolean;
}

export interface ComplianceDecision {
  allowed: boolean;
  ruleCode: string;
  reasons: string[];
}

export function resolveRule<T extends { countryCode: string }>(rules: T[], country: string | null | undefined): T | undefined {
  const c = (country ?? '').toUpperCase();
  return (
    rules.find((r) => r.countryCode === c) ??
    (EU_EEA.includes(c) ? rules.find((r) => r.countryCode === 'EU') : undefined) ??
    rules.find((r) => r.countryCode === '*')
  );
}

export function evaluateCompliance(
  rules: Array<Pick<ComplianceRuleInput, 'countryCode' | 'sendingAllowed' | 'allowedLawfulBases' | 'requirePostalAddress'>>,
  ctx: ComplianceContext,
): ComplianceDecision {
  const rule = resolveRule(rules, ctx.country);
  if (!rule) return { allowed: false, ruleCode: 'none', reasons: ['No compliance rule configured for this country'] };
  const reasons: string[] = [];
  if (!rule.sendingAllowed) reasons.push(`Sending to ${rule.countryCode} is disabled in compliance settings`);
  if (!rule.allowedLawfulBases.includes(ctx.lawfulBasis)) reasons.push(`Lawful basis ${ctx.lawfulBasis} is not accepted for ${rule.countryCode}`);
  if (rule.requirePostalAddress && !ctx.workspaceHasPostalAddress) reasons.push('Workspace postal address is required but not set');
  return { allowed: reasons.length === 0, ruleCode: rule.countryCode, reasons };
}
