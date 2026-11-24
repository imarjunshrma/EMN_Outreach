import { describe, expect, it } from 'vitest';
import { identityFromScoreReason, type IdentityClaim } from '../../shared/src/identity.js';
import { evaluateIcpQualification, evaluatePersonalizationGates } from '../../shared/src/personalization-gates.js';

const lead = { firstName: 'Asha', lastName: 'Raman', companyName: 'Synthetic Labs' };
const identityClaim: IdentityClaim = {
  id: 'identity-1',
  category: 'professional_identity',
  sourceType: 'WEBSITE',
  text: 'Asha Raman is the founder of Synthetic Labs.',
};
const baseGates = { contactable: true, researchSatisfied: true, identityVerified: true, qualified: true, serviceEligible: true };

describe('independent identity, qualification, contactability, and service gates', () => {
  it('1. allows generation only when verified identity and ICP qualification both pass', () => {
    const identity = identityFromScoreReason(lead, { met: true, identityStatus: 'VERIFIED', claimIds: ['identity-1'] }, [identityClaim]);
    const qualification = evaluateIcpQualification(85, 60);
    const result = evaluatePersonalizationGates({ ...baseGates, identityVerified: identity.verified, qualified: qualification.qualified });
    expect(identity.verified).toBe(true);
    expect(qualification.decision).toBe('QUALIFIED');
    expect(result.canGenerate).toBe(true);
  });

  it('2. keeps verified identity true when the prospect fails ICP qualification', () => {
    const identity = identityFromScoreReason(lead, { met: true, identityStatus: 'VERIFIED', claimIds: ['identity-1'] }, [identityClaim]);
    const qualification = evaluateIcpQualification(45, 60);
    const result = evaluatePersonalizationGates({ ...baseGates, identityVerified: identity.verified, qualified: qualification.qualified });
    expect(identity.verified).toBe(true);
    expect(qualification.decision).toBe('NOT_QUALIFIED');
    expect(result.gates.identity).toBe('PASS');
    expect(result.gates.qualification).toBe('BLOCKED');
    expect(result.canGenerate).toBe(false);
  });

  it('3. preserves apparent ICP qualification when identity is unverified, while blocking generation', () => {
    const identity = identityFromScoreReason(lead, { met: false, identityStatus: 'UNKNOWN', claimIds: [] }, []);
    const qualification = evaluateIcpQualification(90, 60);
    const result = evaluatePersonalizationGates({ ...baseGates, identityVerified: identity.verified, qualified: qualification.qualified });
    expect(identity.verified).toBe(false);
    expect(qualification.decision).toBe('QUALIFIED');
    expect(result.gates.qualification).toBe('PASS');
    expect(result.gates.identity).toBe('BLOCKED');
    expect(result.canGenerate).toBe(false);
  });

  it('4. rejects a claimed VERIFIED status without cited identity evidence', () => {
    expect(identityFromScoreReason(lead, { met: false, identityStatus: 'VERIFIED', claimIds: [] }, [identityClaim]).verified).toBe(false);
    expect(identityFromScoreReason(lead, { met: false, identityStatus: 'UNKNOWN', claimIds: ['identity-1'] }, [identityClaim]).verified).toBe(false);
  });

  it('5. rejects conflicting supported professional-affiliation evidence', () => {
    const conflicting: IdentityClaim = { ...identityClaim, id: 'identity-2', text: 'Asha Raman works at Other Labs.' };
    const identity = identityFromScoreReason(lead, { met: true, identityStatus: 'VERIFIED', claimIds: ['identity-1'] }, [identityClaim, conflicting]);
    expect(identity.verified).toBe(false);
    expect(identity.reason).toMatch(/conflicting/i);
  });

  it('6. blocks a prospect with verified identity and no contactability', () => {
    const result = evaluatePersonalizationGates({ ...baseGates, contactable: false });
    expect(result.gates.identity).toBe('PASS');
    expect(result.gates.contactability).toBe('BLOCKED');
    expect(result.canGenerate).toBe(false);
  });

  it('7. blocks a verified, qualified prospect without an eligible approved EMN service', () => {
    const result = evaluatePersonalizationGates({ ...baseGates, serviceEligible: false });
    expect(result.gates.identity).toBe('PASS');
    expect(result.gates.qualification).toBe('PASS');
    expect(result.gates.serviceEligibility).toBe('BLOCKED');
    expect(result.canGenerate).toBe(false);
  });
});
