export type MailboxHealthStatus = 'Healthy' | 'Monitoring' | 'Warning' | 'Paused' | 'Disconnected';
export interface MailboxHealthInput {
  connectionStatus: string;
  sent30d: number;
  hardBounces30d: number;
  complaints30d: number;
  domainHealth: string | null;
  domainVerified: boolean;
  lastSyncedAt: Date | string | null;
  lastErrorAt: Date | string | null;
  now?: Date;
}

/** Reports observed connection and sending signals; it is not a reputation or inbox-placement score. */
export function classifyMailboxHealth(input: MailboxHealthInput): { status: MailboxHealthStatus; reasons: string[]; measuredAt: string; disclaimer: string } {
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const result = (status: MailboxHealthStatus) => ({ status, reasons, measuredAt: now.toISOString(), disclaimer: 'This status summarizes observed connection, DNS and sending signals. It does not measure spam placement or guarantee deliverability.' });

  if (input.connectionStatus === 'PAUSED') {
    reasons.push('Mailbox sending is paused by an administrator.');
    return result('Paused');
  }
  if (['DISCONNECTED', 'NEEDS_REAUTH'].includes(input.connectionStatus)) {
    reasons.push(input.connectionStatus === 'NEEDS_REAUTH' ? 'Mailbox authorization needs renewal.' : 'Mailbox is disconnected.');
    return result('Disconnected');
  }
  if (input.connectionStatus !== 'CONNECTED') reasons.push(`Mailbox connection status is ${input.connectionStatus.toLowerCase().replaceAll('_', ' ')}.`);

  const bounceRate = input.sent30d ? input.hardBounces30d / input.sent30d : null;
  if (input.complaints30d > 0) reasons.push(`${input.complaints30d} complaint event(s) were observed in the last 30 days.`);
  if (bounceRate !== null && bounceRate >= 0.02) reasons.push(`Hard-bounce rate is ${(bounceRate * 100).toFixed(2)}% over the last 30 days.`);
  if (input.domainHealth && input.domainHealth !== 'HEALTHY') reasons.push(`Domain authentication status is ${input.domainHealth.toLowerCase()}.`);
  if (input.domainHealth === 'HEALTHY' && !input.domainVerified) reasons.push('Domain ownership is not verified in this workspace.');

  const lastSync = input.lastSyncedAt ? new Date(input.lastSyncedAt).getTime() : null;
  const syncAge = lastSync === null ? null : now.getTime() - lastSync;
  if (syncAge === null) reasons.push('No successful mailbox synchronization has been recorded yet.');
  else if (syncAge > 24 * 60 * 60_000) reasons.push('Last successful mailbox synchronization was more than 24 hours ago.');
  else if (syncAge > 6 * 60 * 60_000) reasons.push('Mailbox synchronization is delayed by more than 6 hours.');

  const errorAt = input.lastErrorAt ? new Date(input.lastErrorAt).getTime() : null;
  if (errorAt !== null && now.getTime() - errorAt < 24 * 60 * 60_000) reasons.push('A provider error was recorded within the last 24 hours.');
  if (input.sent30d === 0) reasons.push('No sent-message health sample is available for the last 30 days.');

  if (input.connectionStatus !== 'CONNECTED' || input.complaints30d > 0 || (bounceRate !== null && bounceRate >= 0.02) || (errorAt !== null && now.getTime() - errorAt < 24 * 60 * 60_000) || (syncAge !== null && syncAge > 24 * 60 * 60_000)) return result('Warning');
  if (!input.domainHealth || input.domainHealth === 'UNKNOWN' || !input.domainVerified || input.sent30d === 0 || syncAge === null || (syncAge !== null && syncAge > 6 * 60 * 60_000)) return result('Monitoring');
  if (input.domainHealth !== 'HEALTHY') return result('Warning');
  return result('Healthy');
}
