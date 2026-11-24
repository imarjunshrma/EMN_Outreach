export type GateStatus = 'PASS' | 'BLOCKED';
export type PersonalizationGateName = 'contactability' | 'research' | 'identity' | 'qualification' | 'serviceEligibility';

export interface PersonalizationGateInputs {
  contactable: boolean;
  researchSatisfied: boolean;
  identityVerified: boolean;
  qualified: boolean;
  serviceEligible: boolean;
}

/** ICP fit is scored independently; identity and contactability are separate outreach gates. */
export function evaluateIcpQualification(score: number, minimumScore: number) {
  const qualified = score >= minimumScore;
  return { qualified, decision: qualified ? 'QUALIFIED' as const : 'NOT_QUALIFIED' as const };
}

/** Keep the independent sendability predicates visible; any failed predicate blocks generation. */
export function evaluatePersonalizationGates(input: PersonalizationGateInputs) {
  const gates: Record<PersonalizationGateName, GateStatus> = {
    contactability: input.contactable ? 'PASS' : 'BLOCKED',
    research: input.researchSatisfied ? 'PASS' : 'BLOCKED',
    identity: input.identityVerified ? 'PASS' : 'BLOCKED',
    qualification: input.qualified ? 'PASS' : 'BLOCKED',
    serviceEligibility: input.serviceEligible ? 'PASS' : 'BLOCKED',
  };
  const blockedBy = (Object.entries(gates) as Array<[PersonalizationGateName, GateStatus]>)
    .filter(([, status]) => status === 'BLOCKED')
    .map(([name]) => name);
  return { gates, blockedBy, canGenerate: blockedBy.length === 0 };
}
