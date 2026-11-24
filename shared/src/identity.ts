export interface IdentityLead { firstName?: string | null; lastName?: string | null; companyName?: string | null }
export interface IdentityClaim { id: string; text: string; category: string; sourceType: string }
export interface IdentityAssessmentReason { met?: boolean; identityStatus?: string; claimIds?: unknown; explanation?: string }
const normalize = (v: string) => v.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function conflictingAffiliation(text: string, targetCompany: string) {
  const normalizedText = normalize(text);
  // A source explicitly denying or questioning the target affiliation defeats a
  // positive claim, even if another sentence on that page mentions the company.
  if (/\b(?:does not|doesn't|not|never|cannot|can't|unable to)\b.{0,100}\b(?:confirm|identify|work|employ|affiliate|associate|belong)\b/.test(normalizedText)
    && normalizedText.includes(targetCompany)) return true;

  const patterns = [
    /\b(?:works?|employed|based|affiliated)\s+(?:at|for|with)\s+([^,.;]+?)(?=\s+and\s+|\s+but\s+|[,.;]|$)/gi,
    /\b(?:founder|cofounder|co-founder|ceo|owner|managing partner|president|director|employee)\s+(?:of|at|for|with)\s+([^,.;]+?)(?=\s+and\s+|\s+but\s+|[,.;]|$)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const organization = normalize(match[1]);
      if (organization && !organization.includes(targetCompany) && !targetCompany.includes(organization)) return true;
    }
  }
  return false;
}

/** Require an AI identity decision plus independently checked, cited, non-user-provided source text. */
export function verifyProspectIdentity(lead: IdentityLead, status: string, claimedIds: string[], claims: IdentityClaim[]) {
  const name = normalize([lead.firstName, lead.lastName].filter(Boolean).join(' '));
  const company = normalize(lead.companyName ?? '');
  const cited = new Set(claimedIds);
  if (status !== 'VERIFIED') return { verified: false, reason: status === 'AMBIGUOUS' ? 'Identity is ambiguous in research.' : status === 'MISMATCH' ? 'Research indicates a different person or company.' : 'Research did not verify the prospect identity.', claimIds: [] as string[] };
  if (!name || !company) return { verified: false, reason: 'A full name and company name are required to verify professional identity.', claimIds: [] as string[] };
  const identityClaims = claims.filter((claim) => claim.category === 'professional_identity' && claim.sourceType !== 'USER_PROVIDED' && normalize(claim.text).includes(name));
  if (identityClaims.some((claim) => conflictingAffiliation(claim.text, company))) {
    return { verified: false, reason: 'Research contains conflicting professional affiliation evidence.', claimIds: [] as string[] };
  }
  const matches = claims.filter((claim) => {
    if (!cited.has(claim.id) || claim.category !== 'professional_identity' || claim.sourceType === 'USER_PROVIDED') return false;
    const text = normalize(claim.text);
    return text.includes(name) && text.includes(company);
  }).map((claim) => claim.id);
  return matches.length
    ? { verified: true, reason: 'A cited, supported professional identity claim matches the prospect name and company.', claimIds: matches }
    : { verified: false, reason: 'The cited professional identity claim did not match the exact prospect name and company.', claimIds: [] as string[] };
}

/** Rebuild the identity decision from its own persisted assessment, never from ICP qualification. */
export function identityFromScoreReason(lead: IdentityLead, reason: IdentityAssessmentReason | undefined, claims: IdentityClaim[]) {
  const status = reason?.identityStatus ?? (reason?.met === true ? 'VERIFIED' : 'UNKNOWN');
  const claimIds = Array.isArray(reason?.claimIds) ? reason.claimIds.filter((id): id is string => typeof id === 'string') : [];
  return verifyProspectIdentity(lead, status, claimIds, claims);
}
