import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// AES-256-GCM envelope encryption with a versioned keyring (ENCRYPTION_KEYS="1:<b64>,2:<b64>").
// Envelope format: v<keyVersion>:<iv b64>:<tag b64>:<ciphertext b64>

export class Keyring {
  private readonly keys = new Map<number, Buffer>();
  constructor(spec: string, private readonly active: number) {
    for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const idx = part.indexOf(':');
      const version = Number(part.slice(0, idx));
      const key = Buffer.from(part.slice(idx + 1), 'base64');
      if (!Number.isInteger(version) || key.length !== 32) throw new Error('ENCRYPTION_KEYS entries must be "<int>:<base64 32 bytes>"');
      this.keys.set(version, key);
    }
    if (!this.keys.has(active)) throw new Error(`ENCRYPTION_ACTIVE_KEY ${active} not present in ENCRYPTION_KEYS`);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.active)!, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v${this.active}:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(envelope: string): string {
    const [v, iv, tag, ct] = envelope.split(':');
    const key = this.keys.get(Number(v?.slice(1)));
    if (!key || !iv || !tag || ct === undefined) throw new Error('Invalid or unknown-key ciphertext');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  }

  keyVersionOf(envelope: string): number {
    return Number(envelope.split(':')[0]?.slice(1));
  }

  get activeVersion() { return this.active; }
}

let ring: Keyring | null = null;
export function keyring(): Keyring {
  if (!ring) ring = new Keyring(process.env.ENCRYPTION_KEYS ?? '', Number(process.env.ENCRYPTION_ACTIVE_KEY ?? 1));
  return ring;
}
export function setKeyringForTests(k: Keyring) { ring = k; }

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function pkcePair() {
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Signed, URL-safe token: base64url(json).signature */
export function signPayload(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

export function verifyPayload<T>(secret: string, token: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(hmac(secret, body), sig)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T; } catch { return null; }
}
