import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderGuards, tenantRelations } from '../../scripts/generate-tenant-guards.js';

describe('tenant integrity guards', () => {
  it('the committed SQL matches the current schema (regenerate with scripts/generate-tenant-guards.ts)', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    expect(readFileSync('prisma/sql/002_tenant_guards.sql', 'utf8')).toBe(renderGuards(schema));
    expect(tenantRelations(schema).length).toBeGreaterThan(60);
  });
});
