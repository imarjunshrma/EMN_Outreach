import { z } from 'zod';
import { db, Prisma } from './db.js';

// Global, super-admin editable settings ("Platform → Global settings"). One registry drives validation, defaults,
// the settings screen and the in-process cache that request handling reads synchronously (cfg()).
// Rows live in PlatformSetting (key → JSON). A missing row means "default".

export const SETTING_SCHEMAS = {
  /** 'env' keeps REGISTRATION_OPEN / billing default; 'open' / 'closed' override it. */
  signupMode: z.enum(['env', 'open', 'closed']),
  announcement: z.object({ enabled: z.boolean(), level: z.enum(['info', 'warning', 'danger']), message: z.string().trim().max(500) }),
  /** Maintenance mode: tenants can read but not change anything; staff (and staff signed in as a user) are not blocked. */
  maintenance: z.object({ enabled: z.boolean(), message: z.string().trim().max(500) }),
  security: z.object({
    passwordMinLength: z.number().int().min(8).max(128),
    /** Sessions end after this many days without activity. */
    sessionIdleDays: z.number().int().min(1).max(90),
    /** Every user must turn on two-factor sign-in before using any workspace. */
    requireMfaForAllUsers: z.boolean(),
    /** Longest "log in as" session a super admin can open. */
    impersonationMaxMinutes: z.number().int().min(5).max(480),
  }),
  signups: z.object({
    /** Plan new self-service organizations start on (empty = cheapest active plan). Only used when billing is on. */
    defaultPlanCode: z.string().trim().max(40),
    /** How many organizations one person may own (null = MAX_ORGS_PER_USER from the server, default 5). */
    maxOrgsPerUser: z.number().int().min(1).max(1000).nullable(),
  }),
  branding: z.object({
    appName: z.string().trim().min(2).max(60),
    supportEmail: z.union([z.literal(''), z.string().trim().toLowerCase().email()]),
  }),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]> };
export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

export const SETTING_DEFAULTS: Settings = {
  signupMode: 'env',
  announcement: { enabled: false, level: 'info', message: '' },
  maintenance: { enabled: false, message: '' },
  security: { passwordMinLength: 12, sessionIdleDays: 7, requireMfaForAllUsers: false, impersonationMaxMinutes: 60 },
  signups: { defaultPlanCode: '', maxOrgsPerUser: null },
  branding: { appName: 'EMN Outreach OS', supportEmail: '' },
};

/** Stored values are merged over the defaults key by key, so a new sub-setting never breaks an older row. */
function merge<K extends SettingKey>(key: K, stored: unknown): Settings[K] {
  const def = SETTING_DEFAULTS[key];
  const candidate = def && typeof def === 'object' && stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...(def as object), ...(stored as object) } : stored ?? def;
  const parsed = SETTING_SCHEMAS[key].safeParse(candidate);
  return (parsed.success ? parsed.data : def) as Settings[K];
}

let cache: { at: number; values: Settings } | null = null;
let inflight: Promise<Settings> | null = null;
const TTL_MS = () => (process.env.NODE_ENV === 'test' ? 0 : 15_000);

export async function loadSettings(): Promise<Settings> {
  const rows = await db().platformSetting.findMany({ where: { key: { in: SETTING_KEYS } } });
  const values = Object.fromEntries(SETTING_KEYS.map((k) => [k, merge(k, rows.find((r) => r.key === k)?.value)])) as Settings;
  cache = { at: Date.now(), values };
  return values;
}

/** Refreshes the cache when it is older than 15 s (always in tests). Called once per request by the auth middleware. */
export async function ensureConfigFresh(): Promise<Settings> {
  if (cache && Date.now() - cache.at < TTL_MS()) return cache.values;
  inflight ??= loadSettings().finally(() => { inflight = null; });
  try { return await inflight; } catch { return cache?.values ?? SETTING_DEFAULTS; }
}

/** Current settings, synchronously (defaults until the first load). */
export function cfg(): Settings {
  return cache?.values ?? SETTING_DEFAULTS;
}

/** Saves some settings, updates this process's cache immediately and returns the full set. */
export async function saveSettings(values: Partial<Settings>, updatedById: string): Promise<Settings> {
  const entries = Object.entries(values).filter(([k, v]) => v !== undefined && (SETTING_KEYS as string[]).includes(k));
  await db().$transaction(entries.map(([key, value]) => db().platformSetting.upsert({
    where: { key }, update: { value: value as Prisma.InputJsonValue, updatedById }, create: { key, value: value as Prisma.InputJsonValue, updatedById },
  })));
  return loadSettings();
}
