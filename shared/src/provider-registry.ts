// Provider capability registry. "implemented" means an adapter exists in this codebase (still needs a
// live credential test); "manual" means the platform shows instructions but cannot automate it;
// "not_supported" means the vendor offers no suitable public API (as far as reviewed). Nothing here
// claims an API that has not been reviewed.

export type CapabilityState = 'implemented' | 'manual' | 'not_supported' | 'unreviewed';
export interface ProviderCapabilities {
  id: string; name: string; kind: 'registrar_dns' | 'mailbox_provider' | 'mailbox_infrastructure';
  capabilities: Record<'registerDomain' | 'dnsRead' | 'dnsWrite' | 'mailboxCreate' | 'mailboxDelete' | 'mailboxStatus' | 'credentialRetrieval' | 'usageInfo', CapabilityState>;
  notes: string;
}

const none = { registerDomain: 'manual', dnsRead: 'manual', dnsWrite: 'manual', mailboxCreate: 'manual', mailboxDelete: 'manual', mailboxStatus: 'manual', credentialRetrieval: 'manual', usageInfo: 'manual' } as const;

export const PROVIDER_REGISTRY: ProviderCapabilities[] = [
  { id: 'cloudflare', name: 'Cloudflare', kind: 'registrar_dns', capabilities: { ...none, registerDomain: 'not_supported', dnsRead: 'implemented', dnsWrite: 'implemented', mailboxCreate: 'not_supported', mailboxDelete: 'not_supported', mailboxStatus: 'not_supported', credentialRetrieval: 'not_supported', usageInfo: 'not_supported' }, notes: 'DNS records via API v4 with a scoped API token. Cloudflare Registrar has no public API for new registrations — register in the dashboard.' },
  { id: 'godaddy', name: 'GoDaddy', kind: 'registrar_dns', capabilities: { ...none, dnsRead: 'unreviewed', dnsWrite: 'unreviewed', mailboxCreate: 'not_supported', mailboxDelete: 'not_supported', mailboxStatus: 'not_supported', credentialRetrieval: 'not_supported', usageInfo: 'not_supported' }, notes: 'Use manual DNS guidance. An adapter can be added after reviewing GoDaddy\'s current API access rules.' },
  { id: 'namecheap', name: 'Namecheap', kind: 'registrar_dns', capabilities: { ...none, dnsRead: 'unreviewed', dnsWrite: 'unreviewed', mailboxCreate: 'not_supported', mailboxDelete: 'not_supported', mailboxStatus: 'not_supported', credentialRetrieval: 'not_supported', usageInfo: 'not_supported' }, notes: 'Namecheap API requires whitelisted IPs; manual DNS guidance for now.' },
  { id: 'google_workspace', name: 'Google Workspace', kind: 'mailbox_provider', capabilities: { ...none, registerDomain: 'not_supported', mailboxCreate: 'unreviewed', mailboxDelete: 'unreviewed', mailboxStatus: 'implemented', credentialRetrieval: 'not_supported' }, notes: 'Mailboxes are connected with OAuth (implemented). Creating users needs the Admin SDK with domain-wide admin consent — not automated.' },
  { id: 'microsoft_365', name: 'Microsoft 365', kind: 'mailbox_provider', capabilities: { ...none, registerDomain: 'not_supported', mailboxCreate: 'unreviewed', mailboxDelete: 'unreviewed', mailboxStatus: 'implemented', credentialRetrieval: 'not_supported' }, notes: 'Mailboxes connected with OAuth (implemented). User provisioning via Graph needs admin application permissions — not automated.' },
  { id: 'primeforge', name: 'Primeforge', kind: 'mailbox_infrastructure', capabilities: { registerDomain: 'unreviewed', dnsRead: 'unreviewed', dnsWrite: 'unreviewed', mailboxCreate: 'unreviewed', mailboxDelete: 'unreviewed', mailboxStatus: 'unreviewed', credentialRetrieval: 'unreviewed', usageInfo: 'unreviewed' }, notes: 'No public API documentation reviewed. Provision in their dashboard, then connect the mailboxes here with OAuth/SMTP.' },
  { id: 'maildoso', name: 'Maildoso', kind: 'mailbox_infrastructure', capabilities: { registerDomain: 'unreviewed', dnsRead: 'unreviewed', dnsWrite: 'unreviewed', mailboxCreate: 'unreviewed', mailboxDelete: 'unreviewed', mailboxStatus: 'unreviewed', credentialRetrieval: 'unreviewed', usageInfo: 'unreviewed' }, notes: 'No public API documentation reviewed. Provision in their dashboard, then connect via SMTP/IMAP.' },
  { id: 'icemail', name: 'Icemail', kind: 'mailbox_infrastructure', capabilities: { registerDomain: 'unreviewed', dnsRead: 'unreviewed', dnsWrite: 'unreviewed', mailboxCreate: 'unreviewed', mailboxDelete: 'unreviewed', mailboxStatus: 'unreviewed', credentialRetrieval: 'unreviewed', usageInfo: 'unreviewed' }, notes: 'No public API documentation reviewed. Provision in their dashboard, then connect the mailboxes here.' },
];
