import { z } from 'zod';

export const StructuredExclusionRuleSchema = z.object({
  code: z.string().trim().min(2).max(80).regex(/^[A-Z][A-Z0-9_]*$/),
  dimension: z.enum(['INDUSTRY', 'GEOGRAPHY', 'EMPLOYEE_COUNT', 'COMPANY_TYPE', 'PROSPECT_ROLE', 'SENIORITY', 'BUSINESS_CATEGORY']),
  operator: z.enum(['EQUALS_ANY', 'CONTAINS_ANY', 'LT', 'LTE', 'GT', 'GTE']),
  values: z.array(z.union([z.string().trim().min(1).max(200), z.number().finite()])).min(1).max(30),
  missingBehavior: z.enum(['HOLD', 'ALLOW']).default('HOLD'),
  explanation: z.string().trim().min(1).max(300),
}).superRefine((rule, ctx) => {
  const numeric = ['LT', 'LTE', 'GT', 'GTE'].includes(rule.operator);
  if (numeric && (rule.dimension !== 'EMPLOYEE_COUNT' || rule.values.length !== 1 || typeof rule.values[0] !== 'number')) {
    ctx.addIssue({ code: 'custom', path: ['values'], message: 'Numeric operators require one numeric employee-count value' });
  }
  if (!numeric && rule.values.some((v) => typeof v !== 'string')) ctx.addIssue({ code: 'custom', path: ['values'], message: 'Text operators require text values' });
});
export type StructuredExclusionRule = z.infer<typeof StructuredExclusionRuleSchema>;

export interface ServiceEligibilityRule {
  serviceVersionId: string;
  name: string;
  status?: string;
  targetIndustries?: string[];
  excludedIndustries?: string[];
  targetGeographies?: string[];
  excludedGeographies?: string[];
  minEmployeeCount?: number | null;
  maxEmployeeCount?: number | null;
  exclusionRules?: StructuredExclusionRule[];
}
export interface ProspectEligibilityFacts { industry?: string | null; country?: string | null; employeeCount?: number | null; companyType?: string | null; role?: string | null; seniority?: string | null; businessCategories?: string[] }
export interface ServiceEligibilityResult { serviceVersionId: string; eligible: boolean; status: 'ELIGIBLE' | 'EXCLUDED' | 'INSUFFICIENT_INFORMATION'; reasonCode: string; reason: string }

const normalized = (v: string) => v.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const has = (values: string[] | undefined, actual: string) => (values ?? []).some((v) => normalized(v) === normalized(actual));

/** Deterministic allow/deny checks. Unknown required facts fail closed; fuzzy business interpretation stays outside this helper. */
export function checkServiceEligibility(service: ServiceEligibilityRule, prospect: ProspectEligibilityFacts): ServiceEligibilityResult {
  const rejected: ServiceEligibilityResult[] = [];
  const insufficient: ServiceEligibilityResult[] = [];
  const reject = (reasonCode: string, reason: string) => rejected.push({ serviceVersionId: service.serviceVersionId, eligible: false, status: 'EXCLUDED', reasonCode, reason });
  const hold = (reasonCode: string, reason: string) => insufficient.push({ serviceVersionId: service.serviceVersionId, eligible: false, status: 'INSUFFICIENT_INFORMATION', reasonCode, reason });
  if (service.status && service.status !== 'APPROVED') return { serviceVersionId: service.serviceVersionId, eligible: false, status: 'EXCLUDED', reasonCode: 'SERVICE_NOT_APPROVED', reason: 'Service version is not currently approved for new campaign use.' };
  if (service.targetIndustries?.length) {
    if (!prospect.industry?.trim()) hold('INDUSTRY_REQUIRED', 'Prospect industry is unknown but this service requires an industry match.');
    else if (!has(service.targetIndustries, prospect.industry)) reject('INDUSTRY_OUT_OF_TARGET', 'Prospect industry is outside the service target industries.');
  }
  if (prospect.industry && has(service.excludedIndustries, prospect.industry)) reject('INDUSTRY_EXCLUDED', 'Prospect industry is explicitly excluded.');
  if (service.targetGeographies?.length) {
    if (!prospect.country?.trim()) hold('GEOGRAPHY_REQUIRED', 'Prospect geography is unknown but this service requires a geography match.');
    else if (!has(service.targetGeographies, prospect.country)) reject('GEOGRAPHY_OUT_OF_TARGET', 'Prospect geography is outside the service target geographies.');
  }
  if (prospect.country && has(service.excludedGeographies, prospect.country)) reject('GEOGRAPHY_EXCLUDED', 'Prospect geography is explicitly excluded.');
  if (service.minEmployeeCount != null || service.maxEmployeeCount != null) {
    if (prospect.employeeCount == null) hold('EMPLOYEE_COUNT_REQUIRED', 'Company size is unknown but this service has employee-count eligibility bounds.');
    else if (service.minEmployeeCount != null && prospect.employeeCount < service.minEmployeeCount) reject('EMPLOYEE_COUNT_BELOW_MINIMUM', 'Company is below the minimum employee count.');
    else if (service.maxEmployeeCount != null && prospect.employeeCount > service.maxEmployeeCount) reject('EMPLOYEE_COUNT_ABOVE_MAXIMUM', 'Company exceeds the maximum employee count.');
  }

  const facts: Record<StructuredExclusionRule['dimension'], string | number | string[] | null | undefined> = {
    INDUSTRY: prospect.industry,
    GEOGRAPHY: prospect.country,
    EMPLOYEE_COUNT: prospect.employeeCount,
    COMPANY_TYPE: prospect.companyType,
    PROSPECT_ROLE: prospect.role,
    SENIORITY: prospect.seniority,
    BUSINESS_CATEGORY: prospect.businessCategories,
  };
  for (const rule of service.exclusionRules ?? []) {
    const actual = facts[rule.dimension];
    const missing = actual == null || actual === '' || (Array.isArray(actual) && actual.length === 0);
    if (missing) {
      if (rule.missingBehavior === 'HOLD') hold(`${rule.code}_FACT_MISSING`, `${rule.explanation} Required prospect information is missing.`);
      continue;
    }
    let matches = false;
    if (['LT', 'LTE', 'GT', 'GTE'].includes(rule.operator)) {
      const a = actual as number; const b = rule.values[0] as number;
      matches = rule.operator === 'LT' ? a < b : rule.operator === 'LTE' ? a <= b : rule.operator === 'GT' ? a > b : a >= b;
    } else {
      const actualValues = (Array.isArray(actual) ? actual : [actual]).map((v) => normalized(String(v)));
      const ruleValues = rule.values.map((v) => normalized(String(v)));
      matches = actualValues.some((value) => ruleValues.some((candidate) => rule.operator === 'EQUALS_ANY' ? value === candidate : value.includes(candidate)));
    }
    if (matches) reject(rule.code, rule.explanation);
  }

  if (rejected.length) return rejected[0];
  if (insufficient.length) return insufficient[0];
  return { serviceVersionId: service.serviceVersionId, eligible: true, status: 'ELIGIBLE', reasonCode: 'SERVICE_ELIGIBLE', reason: 'All configured deterministic service eligibility checks passed.' };
}

export function filterEligibleServices<T extends ServiceEligibilityRule>(services: T[], prospect: ProspectEligibilityFacts) {
  const checked = services.map((service) => ({ service, result: checkServiceEligibility(service, prospect) }));
  return { eligible: checked.filter((x) => x.result.eligible).map((x) => x.service), excluded: checked.filter((x) => !x.result.eligible).map((x) => x.result), results: checked.map((x) => x.result) };
}
