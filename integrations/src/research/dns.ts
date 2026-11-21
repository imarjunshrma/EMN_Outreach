import { promises as dns } from 'node:dns';

// SPF / DKIM / DMARC / MX checks. These are technical configuration checks only; passing them
// does not guarantee inbox placement.

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

export interface DnsLike {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
}

export interface DomainCheckResult {
  spf: { status: CheckStatus; record: string | null };
  dkim: { status: CheckStatus; results: Array<{ selector: string; found: boolean }> };
  dmarc: { status: CheckStatus; record: string | null; policy: string | null };
  mx: { status: CheckStatus; records: Array<{ exchange: string; priority: number }> };
  issues: Array<{ code: string; severity: 'warning' | 'critical'; message: string }>;
}

async function txt(r: DnsLike, name: string): Promise<string[]> {
  try { return (await r.resolveTxt(name)).map((parts) => parts.join('')); } catch { return []; }
}

export async function checkDomain(domain: string, selectors: string[], resolver: DnsLike = dns): Promise<DomainCheckResult> {
  const issues: DomainCheckResult['issues'] = [];
  const spfRecords = (await txt(resolver, domain)).filter((t) => t.toLowerCase().startsWith('v=spf1'));
  let spf: DomainCheckResult['spf'];
  if (spfRecords.length === 0) {
    spf = { status: 'FAIL', record: null };
    issues.push({ code: 'SPF_MISSING', severity: 'critical', message: 'No SPF record. Add one that includes your mailbox provider (e.g. include:_spf.google.com or include:spf.protection.outlook.com).' });
  } else if (spfRecords.length > 1) {
    spf = { status: 'FAIL', record: spfRecords.join(' | ') };
    issues.push({ code: 'SPF_MULTIPLE', severity: 'critical', message: 'Multiple SPF records found; merge them into one.' });
  } else {
    const rec = spfRecords[0];
    const weak = /\+all|\?all/.test(rec);
    spf = { status: weak ? 'WARN' : 'PASS', record: rec };
    if (weak) issues.push({ code: 'SPF_WEAK', severity: 'warning', message: 'SPF ends with +all or ?all; use ~all or -all.' });
  }

  const dkimResults: Array<{ selector: string; found: boolean }> = [];
  for (const s of selectors) {
    const recs = await txt(resolver, `${s}._domainkey.${domain}`);
    dkimResults.push({ selector: s, found: recs.some((r) => /v=dkim1|k=rsa|p=/i.test(r)) });
  }
  const dkimFound = dkimResults.some((d) => d.found);
  if (!dkimFound) issues.push({ code: 'DKIM_NOT_FOUND', severity: 'warning', message: `No DKIM key found for selectors ${selectors.join(', ')}. Enable DKIM signing in your provider and add the selector here. (Microsoft 365 selectors are often CNAMEs: selector1/selector2.)` });

  const dmarcRec = (await txt(resolver, `_dmarc.${domain}`)).find((t) => t.toLowerCase().startsWith('v=dmarc1')) ?? null;
  const policy = dmarcRec?.match(/;\s*p=([a-z]+)/i)?.[1]?.toLowerCase() ?? null;
  let dmarcStatus: CheckStatus = 'FAIL';
  if (!dmarcRec) issues.push({ code: 'DMARC_MISSING', severity: 'critical', message: 'No DMARC record. Start with v=DMARC1; p=none; rua=mailto:dmarc@yourdomain and tighten later.' });
  else if (policy === 'none') { dmarcStatus = 'WARN'; issues.push({ code: 'DMARC_P_NONE', severity: 'warning', message: 'DMARC policy is p=none (monitoring only). Consider quarantine/reject once aligned.' }); }
  else dmarcStatus = 'PASS';

  let mxRecords: Array<{ exchange: string; priority: number }>;
  try { mxRecords = await resolver.resolveMx(domain); } catch { mxRecords = []; }
  if (mxRecords.length === 0) issues.push({ code: 'MX_MISSING', severity: 'critical', message: 'No MX records; replies and bounces cannot be received.' });

  return {
    spf,
    dkim: { status: dkimFound ? 'PASS' : 'WARN', results: dkimResults },
    dmarc: { status: dmarcStatus, record: dmarcRec, policy },
    mx: { status: mxRecords.length ? 'PASS' : 'FAIL', records: mxRecords },
    issues,
  };
}
