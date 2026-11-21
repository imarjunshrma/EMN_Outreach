import { Redis } from 'ioredis';

let shared: Redis | null = null;

export function redisUrl(): string {
  return process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0';
}

/** Shared connection for commands (locks, rate limits, caches). BullMQ creates its own. */
export function redis(): Redis {
  if (!shared) shared = new Redis(redisUrl(), { maxRetriesPerRequest: null, lazyConnect: false });
  return shared;
}

export function newRedis(): Redis {
  return new Redis(redisUrl(), { maxRetriesPerRequest: null });
}

export async function closeRedis() {
  if (shared) { await shared.quit().catch(() => undefined); shared = null; }
}

/** Simple single-node lock (SET NX PX). Returns a release function or null if not acquired. */
export async function acquireLock(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const ok = await redis().set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;
  return async () => {
    await redis().eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1, `lock:${key}`, token,
    );
  };
}

/** Fixed-window rate limiter. Returns remaining count (negative = limited). */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; remaining: number; resetSec: number }> {
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const n = await redis().incr(k);
  if (n === 1) await redis().expire(k, windowSec);
  return { allowed: n <= limit, remaining: limit - n, resetSec: windowSec - (Math.floor(Date.now() / 1000) % windowSec) };
}
