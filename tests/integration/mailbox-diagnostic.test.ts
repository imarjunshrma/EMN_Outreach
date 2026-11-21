import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, installFakes, createUserSession, addMailbox } from '../helpers/harness.js';
import * as accounts from '../../backend/src/services/accounts.js';

let fakes: ReturnType<typeof installFakes>;
describe('explicit mailbox delivery diagnostic', () => {
  beforeEach(async () => { await resetDb(); fakes = installFakes(); });

  it('sends one clearly labeled diagnostic only back to its own authorized mailbox', async () => {
    const session = await createUserSession('mailbox-diagnostic@example.test');
    const mailbox = await addMailbox(session.workspaceId, 'owner@ourco.test');
    const result = await accounts.sendMailboxDiagnostic(session.workspaceId, mailbox.id, { type: 'USER', userId: session.userId });
    expect(result.acceptedByProvider).toBe(true);
    expect(result.note).toMatch(/does not measure inbox placement/);
    expect(fakes.gmail.sent).toHaveLength(1);
    expect(fakes.gmail.sent[0]).toMatchObject({
      from: { address: 'owner@ourco.test' }, to: 'owner@ourco.test',
      subject: '[EMN mailbox diagnostic] Explicit self-test',
      headers: { 'X-EMN-Mailbox-Diagnostic': '1' },
    });
    expect(fakes.gmail.sent[0].text).toMatch(/No reply or engagement action is requested/);
  });

  it('does not reveal or send through a mailbox from another workspace', async () => {
    const owner = await createUserSession('mailbox-owner@example.test');
    const other = await createUserSession('mailbox-other@example.test');
    const mailbox = await addMailbox(owner.workspaceId, 'private@ourco.test');
    await expect(accounts.sendMailboxDiagnostic(other.workspaceId, mailbox.id, { type: 'USER', userId: other.userId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
