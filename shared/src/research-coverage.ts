export const RESEARCH_AREAS = {
  identity: 'Professional identity',
  company: 'Company and services',
  background: 'Professional background',
  linkedin: 'LinkedIn',
  social: 'Public social activity',
  interviews: 'Videos, podcasts and interviews',
  signals: 'Recent business signals',
  evidence: 'Evidence quality and diversity',
} as const;

export type ResearchArea = keyof typeof RESEARCH_AREAS;
export type CoverageStatus = 'COMPLETED' | 'PARTIAL' | 'NOT_INVESTIGATED' | 'INACCESSIBLE' | 'FAILED' | 'NOT_APPLICABLE';
export type CoverageEntry = { status: CoverageStatus; detail: string };

export function initialCoverage(): Record<ResearchArea, CoverageEntry> {
  return Object.fromEntries(Object.keys(RESEARCH_AREAS).map((key) =>
    [key, { status: 'NOT_INVESTIGATED', detail: 'No source investigated in this area.' }],
  )) as Record<ResearchArea, CoverageEntry>;
}

export function overallCoverage(areas: Record<ResearchArea, CoverageEntry>) {
  const applicable = Object.values(areas).filter((area) => area.status !== 'NOT_APPLICABLE');
  if (applicable.length && applicable.every((area) => area.status === 'COMPLETED')) return 'COMPLETE';
  return applicable.some((area) => area.status === 'COMPLETED' || area.status === 'PARTIAL') ? 'PARTIAL' : 'INSUFFICIENT';
}
