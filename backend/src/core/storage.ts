import { mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Storage adapter: local disk (default) or any S3-compatible object store (AWS S3, Cloudflare R2,
// Backblaze B2, Wasabi, MinIO…). Business code only sees StorageAdapter.

export interface StorageAdapter {
  put(workspaceId: string, kind: string, data: Buffer, ext?: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Readable;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Time-limited download URL, or null when the API must stream the file itself (local disk). */
  signedUrl(key: string, ttlSec: number, fileName?: string): Promise<string | null>;
  /** Permanently removes every object of one workspace (tenant deletion). */
  deletePrefix(workspaceId: string): Promise<void>;
  /** Total bytes stored for one workspace. */
  usage(workspaceId: string): Promise<number>;
}

/** Keys always start with "<workspaceId>/". Use before serving a key that came from a request or a DB row. */
export function assertKeyBelongsTo(key: string, workspaceId: string) {
  if (!key.startsWith(`${workspaceId}/`) || key.includes('..')) throw new Error('Storage key does not belong to this workspace');
}

function newKey(workspaceId: string, kind: string, ext: string) {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error('Invalid workspace id for storage key');
  return `${workspaceId}/${kind.replace(/[^a-z0-9_-]/gi, '')}/${randomUUID()}.${ext.replace(/[^a-z0-9]/gi, '') || 'bin'}`;
}

export class LocalDiskStorage implements StorageAdapter {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  private path(key: string): string {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }

  async put(workspaceId: string, kind: string, data: Buffer, ext = 'bin'): Promise<string> {
    const key = newKey(workspaceId, kind, ext);
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { mode: 0o600 });
    return key;
  }

  async get(key: string) { return readFile(this.path(key)); }
  stream(key: string) { return createReadStream(this.path(key)); }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
  async exists(key: string) { try { await stat(this.path(key)); return true; } catch { return false; } }
  async signedUrl() { return null; }
  async deletePrefix(workspaceId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error('Invalid workspace id');
    await rm(this.path(workspaceId), { recursive: true, force: true });
  }
  async usage(workspaceId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return 0;
    const walk = async (dir: string): Promise<number> => {
      let total = 0;
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) total += e.isDirectory() ? await walk(join(dir, e.name)) : (await stat(join(dir, e.name))).size;
      return total;
    };
    return walk(this.path(workspaceId));
  }
}

export interface S3Config { bucket: string; region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle?: boolean; prefix?: string }

export class S3Storage implements StorageAdapter {
  constructor(private readonly cfg: S3Config, private readonly client: Pick<S3Client, 'send'> = new S3Client({
    region: cfg.region, endpoint: cfg.endpoint || undefined, forcePathStyle: cfg.forcePathStyle,
    credentials: cfg.accessKeyId && cfg.secretAccessKey ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } : undefined,
  })) {}

  private k(key: string) {
    if (key.includes('..') || key.startsWith('/')) throw new Error('Invalid storage key');
    return `${this.cfg.prefix ? `${this.cfg.prefix.replace(/\/$/, '')}/` : ''}${key}`;
  }

  async put(workspaceId: string, kind: string, data: Buffer, ext = 'bin') {
    const key = newKey(workspaceId, kind, ext);
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key), Body: data, ServerSideEncryption: this.cfg.endpoint ? undefined : 'AES256' }));
    return key;
  }

  async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key) }));
    const body = r.Body as { transformToByteArray?: () => Promise<Uint8Array> } | Readable | undefined;
    if (!body) throw new Error('Empty object');
    if ('transformToByteArray' in body && body.transformToByteArray) return Buffer.from(await body.transformToByteArray());
    const chunks: Buffer[] = [];
    for await (const c of body as Readable) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }

  stream(key: string) {
    const out = new PassThrough();
    this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key) }))
      .then((r) => { const b = r.Body as Readable | undefined; if (!b) throw new Error('Empty object'); (b as Readable).pipe(out); })
      .catch((e) => out.destroy(e as Error));
    return out;
  }

  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key) })); }

  async exists(key: string) {
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key) })); return true; } catch { return false; }
  }

  async deletePrefix(workspaceId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error('Invalid workspace id');
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: this.k(`${workspaceId}/`), ContinuationToken: token }));
      const keys = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: keys, Quiet: true } }));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }

  async usage(workspaceId: string) {
    let total = 0; let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: this.k(`${workspaceId}/`), ContinuationToken: token }));
      total += (r.Contents ?? []).reduce((s, o) => s + (o.Size ?? 0), 0);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return total;
  }

  async signedUrl(key: string, ttlSec: number, fileName?: string) {
    const cmd = new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key), ResponseContentDisposition: fileName ? `attachment; filename="${fileName.replace(/["\\\r\n]/g, '_')}"` : undefined });
    return getSignedUrl(this.client as S3Client, cmd, { expiresIn: Math.min(Math.max(ttlSec, 30), 3600) });
  }
}

let storage: StorageAdapter | null = null;
export function store(): StorageAdapter {
  if (!storage) {
    storage = process.env.STORAGE_DRIVER === 's3'
      ? new S3Storage({ bucket: process.env.S3_BUCKET ?? '', region: process.env.S3_REGION ?? 'auto', endpoint: process.env.S3_ENDPOINT, accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', prefix: process.env.S3_PREFIX })
      : new LocalDiskStorage(process.env.STORAGE_ROOT ?? './storage');
  }
  return storage;
}
export function setStorageForTests(s: StorageAdapter) { storage = s; }
