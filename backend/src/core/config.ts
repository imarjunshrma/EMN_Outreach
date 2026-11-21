import { z } from 'zod';

try { process.loadEnvFile(process.env.EMN_ENV_FILE ?? '.env'); } catch { /* real env vars may be provided by systemd */ }

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default('127.0.0.1'), // 0.0.0.0 only inside a container network
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379/0'),
  SESSION_SECRET: z.string().min(32),
  ENCRYPTION_KEYS: z.string().min(1), // "1:<base64 32 bytes>,2:<…>"
  ENCRYPTION_ACTIVE_KEY: z.coerce.number().int().default(1),
  STORAGE_ROOT: z.string().default('./storage'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.optional(),
  S3_PREFIX: z.string().optional(),
  PUBLIC_REGISTRATION: bool.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT: z.string().default('common'),
  GRAPH_WEBHOOKS_ENABLED: bool.default(false),
  WORKER_CONCURRENCY_SEND: z.coerce.number().int().default(4),
  TRUST_PROXY: bool.default(true),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | null = null;

export function loadConfig(overrides: Partial<Record<keyof AppConfig, string>> = {}): AppConfig {
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.STORAGE_DRIVER === 's3' && !parsed.data.S3_BUCKET) throw new Error('Invalid environment configuration:\nS3_BUCKET is required when STORAGE_DRIVER=s3');
  return parsed.data;
}

export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function setConfigForTests(c: AppConfig) {
  cached = c;
}
