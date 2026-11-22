import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { platformAudit } from '../core/tenant.js';

// Super-admin data explorer: every table of the database, browsable per tenant, with each record's links to related
// records. Secrets (password hashes, tokens, encrypted credentials, API keys) are never returned and cannot be edited.
// Edits and deletes need a reason and are recorded with before/after values in the platform audit trail.

type Field = {
  name: string; type: string; kind: 'scalar' | 'enum' | 'object';
  isList: boolean; isOptional: boolean; isId: boolean; isUpdatedAt: boolean; hasDefault: boolean; isUnique: boolean;
  relationName?: string; relationFields?: string[]; secret?: boolean;
};
type Model = { name: string; delegate: string; fields: Field[]; idField: string | null; scope: 'organization' | 'workspace' | 'user' | 'self' | 'member' | 'global' };

// ------------------------------------------------------------------ schema metadata (parsed once from prisma/schema.prisma)

const SECRET_RE = /(password|secret|token|hash|apikey|encrypted|credential|privatekey|recovery|csrf|cookie|signingkey|otp)/i;
/** Fields that are not secret despite their name (counts and public identifiers). */
const NOT_SECRET = new Set(['tokenType', 'prefix', 'keyLast4', 'contentHash', 'approvedContentHash', 'configHash']);

function schemaPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(process.cwd(), 'prisma', 'schema.prisma'), join(here, '../../../prisma/schema.prisma'), join(here, '../../../../prisma/schema.prisma')];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new AppError('INTERNAL', 'prisma/schema.prisma not found next to the server', 500);
  return hit;
}

let parsed: { models: Map<string, Model>; enums: Map<string, string[]> } | null = null;

export function schema() {
  if (parsed) return parsed;
  const src = readFileSync(schemaPath(), 'utf8');
  const enums = new Map<string, string[]>();
  for (const m of src.matchAll(/^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    enums.set(m[1], m[2].split('\n').map((l) => l.replace(/\/\/.*$/, '').trim().split(/\s+/)[0]).filter((v) => v && !v.startsWith('@')));
  }
  const blocks = [...src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  const modelNames = new Set(blocks.map((b) => b[1]));
  const models = new Map<string, Model>();
  for (const [, name, body] of blocks) {
    const fields: Field[] = [];
    for (const line0 of body.split('\n')) {
      const line = line0.replace(/\/\/.*$/, '').trim();
      if (!line || line.startsWith('@@')) continue;
      const m = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
      if (!m) continue;
      const [, fname, type, list, opt, attrs] = m;
      const kind = enums.has(type) ? 'enum' : modelNames.has(type) ? 'object' : 'scalar';
      const rel = attrs.match(/@relation\(([^)]*)\)/);
      const relName = rel?.[1].match(/^\s*"([^"]+)"/)?.[1] ?? rel?.[1].match(/name:\s*"([^"]+)"/)?.[1];
      const relFields = rel?.[1].match(/fields:\s*\[([^\]]*)\]/)?.[1].split(',').map((x) => x.trim()).filter(Boolean);
      fields.push({
        name: fname, type, kind, isList: !!list, isOptional: !!opt, isId: /@id\b/.test(attrs), isUpdatedAt: /@updatedAt\b/.test(attrs),
        hasDefault: /@default\(/.test(attrs), isUnique: /@unique\b/.test(attrs), relationName: kind === 'object' ? relName : undefined, relationFields: relFields,
        secret: kind === 'scalar' && (type === 'Bytes' || ((type === 'String' || type === 'Json') && SECRET_RE.test(fname) && !NOT_SECRET.has(fname))),
      });
    }
    const has = (f: string) => fields.some((x) => x.name === f && x.kind === 'scalar');
    // 'member': personal records (sessions, personal AI connections) shown for a tenant through its members.
    const viaUser = fields.some((f) => f.name === 'user' && f.type === 'User' && f.relationFields?.[0] === 'userId');
    const scope: Model['scope'] = name === 'Organization' ? 'self' : name === 'User' ? 'user' : has('organizationId') ? 'organization' : has('workspaceId') ? 'workspace' : viaUser ? 'member' : 'global';
    models.set(name, { name, delegate: name[0].toLowerCase() + name.slice(1), fields, idField: fields.find((f) => f.isId)?.name ?? null, scope });
  }
  parsed = { models, enums };
  return parsed;
}

function model(name: string) {
  const m = schema().models.get(name);
  if (!m) throw NotFound('Table');
  return m;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delegate = (m: Model): any => {
  const d = (db() as unknown as Record<string, unknown>)[m.delegate];
  if (!d) throw NotFound('Table');
  return d;
};
const scalars = (m: Model) => m.fields.filter((f) => f.kind !== 'object');

// ------------------------------------------------------------------ value handling

/** Hides secret keys inside JSON values (connection settings and the like). */
function redactJson(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactJson(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_RE.test(k) ? '[hidden]' : redactJson(x, depth + 1)]));
}

function out(m: Model, row: Record<string, unknown>) {
  const o: Record<string, unknown> = {};
  for (const f of scalars(m)) {
    if (!(f.name in row)) continue;
    const v = row[f.name];
    if (f.secret) o[f.name] = v === null || v === undefined ? null : '[hidden]';
    else if (typeof v === 'bigint') o[f.name] = v.toString();
    else if (v instanceof Prisma.Decimal) o[f.name] = v.toString();
    else if (f.type === 'Json') o[f.name] = redactJson(v);
    else o[f.name] = v;
  }
  if (row._count) o._count = row._count;
  return o;
}

function coerce(m: Model, f: Field, v: unknown): unknown {
  const bad = (msg: string) => new AppError('VALIDATION_FAILED', `${f.name}: ${msg}`, 400);
  if (v === null) { if (!f.isOptional && !f.isList) throw bad('cannot be empty'); return null; }
  if (f.isList) {
    if (!Array.isArray(v)) throw bad('must be a list');
    return v.map((x) => coerce(m, { ...f, isList: false, isOptional: false }, x));
  }
  if (f.kind === 'enum') {
    const values = schema().enums.get(f.type) ?? [];
    if (typeof v !== 'string' || !values.includes(v)) throw bad(`must be one of ${values.join(', ')}`);
    return v;
  }
  switch (f.type) {
    case 'String': if (typeof v !== 'string') throw bad('must be text'); return v;
    case 'Boolean': if (typeof v !== 'boolean') throw bad('must be true or false'); return v;
    case 'Int': { const n = Number(v); if (!Number.isInteger(n)) throw bad('must be a whole number'); return n; }
    case 'Float': { const n = Number(v); if (!Number.isFinite(n)) throw bad('must be a number'); return n; }
    case 'Decimal': { const n = String(v); if (!/^-?\d+(\.\d+)?$/.test(n)) throw bad('must be a number'); return new Prisma.Decimal(n); }
    case 'BigInt': { if (!/^-?\d+$/.test(String(v))) throw bad('must be a whole number'); return BigInt(String(v)); }
    case 'DateTime': { const d = new Date(String(v)); if (Number.isNaN(d.getTime())) throw bad('must be a date'); return d; }
    case 'Json': return v as Prisma.InputJsonValue;
    default: throw bad('cannot be edited here');
  }
}

// ------------------------------------------------------------------ tenant scoping

async function tenantWhere(m: Model, organizationId?: string, workspaceId?: string): Promise<Record<string, unknown> | null> {
  if (!organizationId && !workspaceId) return {};
  if (workspaceId) {
    if (m.name === 'Workspace') return { id: workspaceId };
    if (m.scope === 'workspace' || m.fields.some((f) => f.name === 'workspaceId' && f.kind === 'scalar')) return { workspaceId };
    if (m.name === 'User') return { memberships: { some: { workspaceId } } };
    if (m.scope === 'member') return { user: { memberships: { some: { workspaceId } } } };
    if (!organizationId) return null;
  }
  if (m.scope === 'self') return { id: organizationId };
  if (m.scope === 'organization') return { organizationId };
  if (m.scope === 'workspace') return { workspace: { organizationId } };
  if (m.scope === 'user') return { orgMemberships: { some: { organizationId } } };
  if (m.scope === 'member') return { user: { orgMemberships: { some: { organizationId } } } };
  return null; // not tenant data
}

function searchWhere(m: Model, q: string) {
  const term = q.trim();
  if (!term) return {};
  if (/^[0-9a-f-]{36}$/i.test(term)) {
    const idish = scalars(m).filter((f) => f.type === 'String' && !f.isList && !f.secret && (f.isId || /Id$/.test(f.name)));
    return { OR: idish.map((f) => ({ [f.name]: term })) };
  }
  const text = scalars(m).filter((f) => f.type === 'String' && !f.isList && !f.secret && !/Id$/.test(f.name) && !f.isId).slice(0, 15);
  if (!text.length) return { id: '__none__' };
  return { OR: text.map((f) => ({ [f.name]: { contains: term, mode: 'insensitive' } })) };
}

// ------------------------------------------------------------------ read

export const ModelsQuery = z.object({ organizationId: z.string().uuid().optional(), workspaceId: z.string().uuid().optional(), counts: z.enum(['true', 'false']).default('true') });

export async function listModels(q: z.infer<typeof ModelsQuery>) {
  const all = [...schema().models.values()].sort((a, b) => a.name.localeCompare(b.name));
  const rows = [];
  for (let i = 0; i < all.length; i += 12) {
    const chunk = await Promise.all(all.slice(i, i + 12).map(async (m) => {
      const where = await tenantWhere(m, q.organizationId, q.workspaceId);
      let count: number | null = null;
      if (q.counts === 'true' && where) count = await delegate(m).count({ where }).catch(() => null);
      return { name: m.name, scope: m.scope, fields: scalars(m).length, relations: m.fields.length - scalars(m).length, count, tenantData: where !== null, editable: !!m.idField };
    }));
    rows.push(...chunk);
  }
  return { models: rows };
}

export const RowsQuery = z.object({
  organizationId: z.string().uuid().optional(), workspaceId: z.string().uuid().optional(),
  q: z.string().max(200).default(''), field: z.string().max(60).optional(), value: z.string().max(500).optional(),
  sort: z.string().max(60).optional(), dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export async function listRows(name: string, q: z.infer<typeof RowsQuery>) {
  const m = model(name);
  const tw = await tenantWhere(m, q.organizationId, q.workspaceId);
  if (tw === null) return { model: describe(m), data: [], total: 0, page: q.page, pageSize: q.pageSize, totalPages: 1, note: 'This table is not tenant data, so the tenant filter shows nothing. Clear the filter to see it.' };
  const where: Record<string, unknown> = { AND: [tw, searchWhere(m, q.q)] };
  if (q.field) {
    const f = scalars(m).find((x) => x.name === q.field && !x.secret);
    if (!f) throw new AppError('VALIDATION_FAILED', 'Unknown or hidden column', 400);
    (where.AND as unknown[]).push({ [f.name]: q.value === '' || q.value === undefined || q.value === 'null' ? null : coerce(m, { ...f, isList: false }, f.type === 'Boolean' ? q.value === 'true' : q.value) });
  }
  const sortField = q.sort && scalars(m).find((f) => f.name === q.sort && !f.isList && f.type !== 'Json') ? q.sort : m.fields.some((f) => f.name === 'createdAt') ? 'createdAt' : m.idField;
  const d = delegate(m);
  const [rows, total] = await Promise.all([
    d.findMany({ where, ...(sortField ? { orderBy: { [sortField]: q.dir } } : {}), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    d.count({ where }),
  ]);
  return { model: describe(m), data: rows.map((r: Record<string, unknown>) => out(m, r)), total, page: q.page, pageSize: q.pageSize, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

function describe(m: Model) {
  return {
    name: m.name, scope: m.scope, idField: m.idField,
    fields: scalars(m).map((f) => ({ name: f.name, type: f.type, kind: f.kind, isList: f.isList, isOptional: f.isOptional, secret: !!f.secret, enumValues: f.kind === 'enum' ? schema().enums.get(f.type) : undefined, editable: isEditable(m, f) })),
  };
}

const LOCKED = new Set(['id', 'organizationId', 'workspaceId', 'createdAt']);
/** Fields with their own audited screens elsewhere in the console. */
const LOCKED_PER_MODEL: Record<string, string[]> = { User: ['platformRole', 'isPlatformAdmin', 'mfaEnabled', 'mfaSecretEnc', 'mfaRecoveryHashes', 'status'], Organization: ['status'], Session: ['impersonatorId', 'impersonationReason'] };
const APPEND_ONLY = new Set(['PlatformAuditEvent', 'AuditLog']);
/** Deleting these would orphan whole tenants; use tenant lifecycle and user screens instead. */
const NO_DELETE = new Set(['User', 'Organization', 'Workspace', 'PlatformAuditEvent', 'AuditLog', 'OrganizationStatusChange', 'TrialGrant']);

function isEditable(m: Model, f: Field) {
  return !!m.idField && !APPEND_ONLY.has(m.name) && f.kind !== 'object' && !f.secret && !f.isId && !f.isUpdatedAt && !LOCKED.has(f.name) && !(LOCKED_PER_MODEL[m.name] ?? []).includes(f.name) && f.type !== 'Bytes';
}

/** The organization a record belongs to, when it is tenant data. */
async function orgOfRow(m: Model, row: Record<string, unknown>): Promise<string | null> {
  if (m.scope === 'self') return String(row.id);
  if (typeof row.organizationId === 'string') return row.organizationId;
  if (typeof row.workspaceId === 'string') return (await db().workspace.findUnique({ where: { id: row.workspaceId }, select: { organizationId: true } }))?.organizationId ?? null;
  return null;
}

async function findRow(m: Model, id: string) {
  if (!m.idField) throw new AppError('VALIDATION_FAILED', 'This table has no single id, so records cannot be opened one by one', 400);
  const lists = m.fields.filter((f) => f.kind === 'object' && f.isList);
  const row = await delegate(m).findUnique({ where: { [m.idField]: id }, ...(lists.length ? { include: { _count: { select: Object.fromEntries(lists.map((f) => [f.name, true])) } } } : {}) });
  if (!row) throw NotFound('Record');
  return row as Record<string, unknown>;
}

export async function getRow(name: string, id: string, admin: { userId: string; ip?: string | null }) {
  const m = model(name);
  const row = await findRow(m, id);
  const organizationId = await orgOfRow(m, row);
  // Links: the record each foreign key points to, and the records pointing back at this one.
  const parents = m.fields.filter((f) => f.kind === 'object' && !f.isList && f.relationFields?.length).map((f) => ({
    field: f.name, model: f.type, id: row[f.relationFields![0]] ?? null,
  })).filter((p) => p.id);
  const children = m.fields.filter((f) => f.kind === 'object' && f.isList).map((f) => {
    const target = schema().models.get(f.type);
    const back = target?.fields.find((x) => x.kind === 'object' && x.type === m.name && x.relationName === f.relationName && x.relationFields?.length)
      ?? target?.fields.find((x) => x.kind === 'object' && x.type === m.name && !x.isList && x.relationFields?.length && !f.relationName);
    return { field: f.name, model: f.type, count: (row._count as Record<string, number> | undefined)?.[f.name] ?? 0, filterField: back?.relationFields?.[0] ?? null };
  });
  await platformAudit({ actorUserId: admin.userId, action: 'data.viewed', organizationId, targetType: m.name, targetId: id, ip: admin.ip });
  return { model: describe(m), record: out(m, row), organizationId, parents, children };
}

// ------------------------------------------------------------------ write

const Reason = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500);
export const UpdateSchema = z.object({ changes: z.record(z.string(), z.unknown()), reason: Reason });
export const DeleteSchema = z.object({ reason: Reason });

export async function updateRow(name: string, id: string, input: z.infer<typeof UpdateSchema>, admin: { userId: string; ip?: string | null }) {
  const m = model(name);
  if (APPEND_ONLY.has(m.name)) throw new AppError('FORBIDDEN', 'Audit records can never be changed', 403);
  const before = await findRow(m, id);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.changes)) {
    const f = m.fields.find((x) => x.name === k);
    if (!f || !isEditable(m, f)) throw new AppError('VALIDATION_FAILED', `${k} cannot be changed here`, 400);
    data[k] = coerce(m, f, v);
  }
  if (!Object.keys(data).length) throw new AppError('VALIDATION_FAILED', 'Nothing to change', 400);
  const after = await delegate(m).update({ where: { [m.idField!]: id }, data });
  const organizationId = await orgOfRow(m, before);
  const shown = (r: Record<string, unknown>) => Object.fromEntries(Object.keys(data).map((k) => [k, out(m, r)[k]]));
  await platformAudit({ actorUserId: admin.userId, action: 'data.updated', organizationId, targetType: m.name, targetId: id, reason: input.reason, ip: admin.ip, metadata: { before: shown(before), after: shown(after) } });
  // Changes to session-relevant rows take effect on the next request; tenant name/status caches have none.
  return getRow(name, id, admin);
}

export async function deleteRow(name: string, id: string, input: z.infer<typeof DeleteSchema>, admin: { userId: string; ip?: string | null }) {
  const m = model(name);
  if (NO_DELETE.has(m.name)) throw new AppError('FORBIDDEN', `${m.name} records are removed through their own screens (tenant lifecycle, user accounts), not here`, 403);
  const before = await findRow(m, id);
  const organizationId = await orgOfRow(m, before);
  try {
    await delegate(m).delete({ where: { [m.idField!]: id } });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2003') throw new AppError('CONFLICT', 'Other records still point at this one. Delete or change those first.', 409);
    throw e;
  }
  await platformAudit({ actorUserId: admin.userId, action: 'data.deleted', organizationId, targetType: m.name, targetId: id, reason: input.reason, ip: admin.ip, metadata: { record: out(m, before) } });
  return { ok: true };
}
