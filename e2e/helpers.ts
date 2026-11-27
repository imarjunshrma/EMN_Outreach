import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { Redis } from 'ioredis';
import pg from 'pg';

/** The isolated browser-test stores, with the same defaults as playwright.config.ts (never the development databases). */
const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://emn:emn@127.0.0.1:5432/emn_e2e';
const E2E_REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/14';

/** Direct SQL against the isolated e2e database — used only to grant a platform role, which has no API by design. */
export async function sql(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await c.connect();
  try { return (await c.query(text, params)).rows; } finally { await c.end(); }
}

/** The suite signs in far more often than a person would; clear the per-IP login limiter between sign-ins
 *  (the limiter itself is covered by the integration tests). Deletes only login rate-limit keys in the e2e Redis DB. */
async function resetLoginLimiter() {
  const r = new Redis(E2E_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await r.connect(); const keys = await r.keys('rl:post:/auth/login:*'); if (keys.length) await r.del(...keys); } catch { /* Redis unavailable: let the test show it */ } finally { r.disconnect(); }
}

export const ADMIN = { email: 'owner@e2e.test', password: 'E2e-password-1234', name: 'E2E Owner', workspaceName: 'E2E Agency' };

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — independent implementation for the browser test. */
export function totp(base32: string, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; for (const ch of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

/** Collects uncaught page errors and console errors (excluding expected 4xx network noise). */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|status of 4\d\d/.test(m.text())) errors.push(`console: ${m.text()}`); });
  return errors;
}

export async function login(page: Page, email = ADMIN.email, password = ADMIN.password) {
  await resetLoginLimiter();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function workspaceBase(page: Page) {
  // Platform staff land in the console after sign-in; step into their workspace like the "Back to my workspace" link.
  // The dev server compiles the workspace route on its first visit, which can take well over the default 5 s.
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}|\/platform/, { timeout: 60_000 });
  if (/\/platform/.test(new URL(page.url()).pathname)) await page.goto('/app?to=workspace');
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}/, { timeout: 60_000 });
  return new URL(page.url()).pathname.match(/^\/w\/[0-9a-f-]{36}/)![0];
}
