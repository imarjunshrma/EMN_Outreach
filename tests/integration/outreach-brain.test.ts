import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, createUserSession } from '../helpers/harness.js';
import * as brain from '../../backend/src/services/outreach-brain.js';

describe('AI Outreach Brain workspace boundaries', () => {
  beforeEach(async () => { await resetDb(); });

  it('lists only the caller workspace rules and refuses cross-workspace updates', async () => {
    const one = await createUserSession('brain-one@example.test');
    const two = await createUserSession('brain-two@example.test');
    const input = brain.RuleInputSchema.parse({ title: 'Use plain language', description: 'Prefer plain language in the first email.', category: 'EMAIL_OPENING', priority: 'PREFERRED' });
    const { rule } = await brain.createRule(one.workspaceId, input, { type: 'SYSTEM' });

    expect((await brain.listRules(one.workspaceId)).rules.map((r) => r.id)).toEqual([rule.id]);
    expect((await brain.listRules(two.workspaceId)).rules).toEqual([]);
    await expect(brain.updateRule(two.workspaceId, rule.id, input, { type: 'SYSTEM' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
