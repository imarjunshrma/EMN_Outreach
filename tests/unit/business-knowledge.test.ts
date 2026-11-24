import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findService: vi.fn(), createService: vi.fn(), audit: vi.fn() }));

vi.mock('../../backend/src/core/db.js', () => ({
  db: () => ({ businessService: { findFirst: mocks.findService, create: mocks.createService } }),
}));
vi.mock('../../backend/src/core/audit.js', () => ({ audit: mocks.audit }));

import { createService, ServiceCreateSchema } from '../../backend/src/services/business-knowledge.js';

describe('business service creation', () => {
  beforeEach(() => {
    mocks.findService.mockReset().mockResolvedValue(null);
    mocks.createService.mockReset().mockResolvedValue({ id: 'service-id', versions: [{ id: 'version-id', status: 'DRAFT' }] });
    mocks.audit.mockReset().mockResolvedValue(undefined);
  });

  it('creates the first draft version through the nested parent relation', async () => {
    await createService('workspace-id', ServiceCreateSchema.parse({ name: 'Content strategy', description: 'A synthetic service description.' }), { type: 'SYSTEM' });

    const payload = mocks.createService.mock.calls[0][0].data;
    expect(payload.workspaceId).toBe('workspace-id');
    expect(payload.versions.create).toMatchObject({ version: 1, status: 'DRAFT', description: 'A synthetic service description.' });
    expect(payload.versions.create).not.toHaveProperty('workspaceId');
    expect(payload.versions.create).not.toHaveProperty('serviceId');
    expect(mocks.audit).toHaveBeenCalledOnce();
  });
});
