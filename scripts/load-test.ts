// Repeatable load test against a running API (never production). It creates its own tenants through the
// public API, then drives each scenario for a fixed time at a fixed concurrency and reports latency
// percentiles, throughput and error rate. Usage:
//   LOAD_BASE_URL=http://127.0.0.1:4200 LOAD_SECONDS=15 LOAD_CONCURRENCY=20 node --import tsx scripts/load-test.ts
// The target must run with REGISTRATION_OPEN=true and an isolated database.
import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:4200';
const SECONDS = Number(process.env.LOAD_SECONDS ?? 15);
const C = Number(process.env.LOAD_CONCURRENCY ?? 20);
if (/emn\.|prod|elitemedianetworks/.test(BASE)) throw new Error('Refusing to load-test something that looks like production');

type Res = { status: number; ms: number };
async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Res & { body?: any; setCookie?: string[] }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const t = performance.now();
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, ms: performance.now() - t, body, setCookie: r.headers.getSetCookie?.() };
}

async function tenant(n: number) {
  const email = `load${n}-${randomUUID().slice(0, 6)}@load.test`;
  const r = await call('/api/v1/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Load', email, password: 'Load-test-password-123', organizationName: `Load Org ${n}`, acceptTerms: true }) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`signup failed ${r.status} ${JSON.stringify(r.body)}`);
  const cookie = (r.setCookie ?? []).map((c) => c.split(';')[0]).join('; ');
  const ws = r.body.workspace.id as string;
  const key = await call(`/api/v1/w/${ws}/api-keys`, { method: 'POST', cookie, headers: { 'x-csrf-token': r.body.csrfToken }, body: JSON.stringify({ name: 'load', role: 'ADMIN' }) });
  return { cookie, csrf: r.body.csrfToken as string, ws, org: r.body.organization.id as string, token: key.body.token as string };
}

async function run(name: string, fn: (i: number) => Promise<Res>) {
  const lat: number[] = []; let errors = 0; let i = 0; const end = Date.now() + SECONDS * 1000;
  const statuses = new Map<number, number>();
  await Promise.all(Array.from({ length: C }, async () => {
    while (Date.now() < end) {
      const r = await fn(i++).catch(() => ({ status: 0, ms: 0 }));
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      if (r.status >= 400 || r.status === 0) errors++; else lat.push(r.ms);
    }
  }));
  lat.sort((a, b) => a - b);
  const p = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1) : '—');
  const total = lat.length + errors;
  console.log(`| ${name} | ${C} | ${total} | ${(total / SECONDS).toFixed(1)} | ${p(0.5)} | ${p(0.95)} | ${p(0.99)} | ${((100 * errors) / Math.max(1, total)).toFixed(2)}% | ${[...statuses].map(([s, n]) => `${s}:${n}`).join(' ')} |`);
}

const a = await tenant(1); const b = await tenant(2);
// seed leads for listing/search
for (let k = 0; k < 300; k++) await call(`/api/v1/w/${a.ws}/leads`, { method: 'POST', headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify({ email: `seed${k}@prospect${k % 30}.example`, firstName: `Seed${k}`, companyName: `Company ${k % 30}` }) });
console.log(`Target ${BASE} · ${SECONDS}s per scenario · concurrency ${C}\n`);
console.log('| Scenario | Concurrency | Requests | Req/s | p50 ms | p95 ms | p99 ms | Errors | Status codes |');
console.log('|---|---|---|---|---|---|---|---|---|');
await run('Session: who am I (org/workspace switch data)', () => call('/api/v1/auth/me', { cookie: a.cookie }));
await run('Workspace: list leads (page 1)', () => call(`/api/v1/w/${a.ws}/leads?pageSize=50`, { headers: { authorization: `Bearer ${a.token}` } }));
await run('Workspace: search leads', (i) => call(`/api/v1/w/${a.ws}/leads?q=Seed${i % 300}`, { headers: { authorization: `Bearer ${a.token}` } }));
await run('Write: create lead (metered API call)', (i) => call(`/api/v1/w/${b.ws}/leads`, { method: 'POST', headers: { authorization: `Bearer ${b.token}` }, body: JSON.stringify({ email: `l${i}-${randomUUID().slice(0, 8)}@load.example` }) }));
await run('Organization: usage and limits', () => call(`/api/v1/orgs/${a.org}/usage`, { cookie: a.cookie }));
await run('Cross-tenant probe (must be 404)', () => call(`/api/v1/w/${a.ws}/leads`, { headers: { authorization: `Bearer ${b.token}` } }).then((r) => ({ ...r, status: r.status === 404 ? 200 : 500 })));
const secret = process.env.STRIPE_WEBHOOK_SECRET;
if (secret) await run('Webhook ingestion (signed Stripe fixture, unique ids)', (i) => {
  const body = JSON.stringify({ id: `evt_load_${i}_${randomUUID()}`, type: 'invoice.paid', created: Math.floor(Date.now() / 1000), data: { object: { id: `in_load_${i}`, customer: 'cus_none', amount_paid: 100, currency: 'usd' } } });
  const t = Math.floor(Date.now() / 1000);
  return call('/api/v1/webhooks/billing/stripe', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}` }, body });
});
await run('Sign-in (rate limited: 10 per 5 min per IP by design)', () => call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'nobody@load.test', password: 'wrong-password-123' }) }).then((r) => ({ ...r, status: r.status === 401 || r.status === 429 ? 200 : r.status })));
process.exit(0);
