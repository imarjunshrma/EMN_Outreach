# DNS implementation review

## Actual support

Cloudflare is the only implemented DNS API adapter (`CloudflareDns` in `integrations/src/providers/extra.ts`). It performs token verification, zone lookup by exact domain, record listing by type/name, and record creation. `backend/src/services/domains.ts` calls it from `applyRecord()` only after an ADMIN action, validates names inside the domain, refuses placeholders, checks existing SPF before a create, writes DNS provider/zone metadata, and audits the operation. The registry (`shared/src/provider-registry.ts`) accurately marks other registrars as manual or unreviewed.

DNS health checking is separate: `integrations/src/research/dns.ts` queries DNS via Node resolver; `services/domains.ts` orchestrates SPF, DKIM, DMARC, MX, ownership and propagation checks. `recommendedRecords()` supplies provider-specific manual guidance. Google/Microsoft DKIM material is not guessed; it states selectors/values must come from the provider console.

## Operations and limits

| Operation | Current implementation | Status |
|---|---|---|
| Token verify | Cloudflare `/user/tokens/verify` | Implemented; mock-tested; live not tested |
| Zone discovery | Cloudflare `/zones?name=...` | Implemented; exact lookup path |
| DNS read | `/zones/{zone}/dns_records` filters | Implemented; live not tested |
| DNS create | POST record; app UI/API currently restricts explicit creation to TXT/CNAME | Implemented; audit logged; SPF duplicate guard |
| Update/delete/list zones/pagination | Not exposed by current product interface; not implemented | Missing from this product scope |
| Provider A/AAAA/MX/SRV/CAA/PTR writes | Not accepted by `ApplyRecordSchema`; read health uses resolver APIs | Not implemented for writes |
| DNSSEC, registrar operations, propagation guarantee | Not provided | Not implemented / not applicable |

A successful Cloudflare API write means the provider accepted it; public resolver propagation is a separate check. The UI does not blindly overwrite records. DNS mutation retries are now disabled at adapter level to avoid duplicate POST after uncertain outcome; GET continues transient retry. Regression tests use mocked HTTP only.

## Security and missing verification

Domain routes require workspace membership; mutation requires ADMIN. Domain lookup in service is workspace scoped. Record names must be the domain or subdomain. Credentials are stored encrypted through integration settings. No live token, zone, or DNS write was used. Provider account association, role scopes, actual Cloudflare error payloads, and propagation remain unverified without controlled credentials.
