import { ZeroBounceProvider, NeverBounceProvider, HunterFinder, CloudflareDns, type EmailFinder, type DnsProviderAdapter } from '../../../integrations/src/providers/extra.js';
import { AnthropicAdapter } from '../../../integrations/src/ai/anthropic.js';
import { OpenAiAdapter } from '../../../integrations/src/ai/openai.js';
import type { AiProviderAdapter } from '../../../integrations/src/ai/types.js';
import { GmailProvider, GoogleOAuthClient } from '../../../integrations/src/email/gmail.js';
import { MicrosoftGraphProvider, MicrosoftOAuthClient } from '../../../integrations/src/email/microsoft.js';
import { SmtpImapProvider } from '../../../integrations/src/email/smtp-imap.js';
import type { ChangeSubscriptionProvider, EmailProvider, EmailProviderName, OAuthClient } from '../../../integrations/src/email/types.js';
import {
  ApolloProvider, BraveSearchProvider, MillionVerifierProvider, SerperSearchProvider, SmartleadAdapter,
  type EmailVerifier, type LeadDataProvider, type WebSearchProvider,
} from '../../../integrations/src/providers/index.js';
import { SafeFetcher } from '../../../integrations/src/research/fetcher.js';
import type { DnsLike } from '../../../integrations/src/research/dns.js';
import { promises as dnsPromises } from 'node:dns';

// Composition root. Tests replace adapters with fakes via setAdapters().

export interface Adapters {
  email: Record<EmailProviderName, EmailProvider>;
  oauth: Partial<Record<'GMAIL' | 'MICROSOFT', OAuthClient>>;
  graphSubscriptions: ChangeSubscriptionProvider | null;
  ai: Record<'OPENAI' | 'ANTHROPIC', AiProviderAdapter>;
  leadData: Record<string, LeadDataProvider>;
  verifiers: Record<string, EmailVerifier>;
  finders: Record<string, EmailFinder>;
  dnsProviders: Record<string, DnsProviderAdapter>;
  search: Record<string, WebSearchProvider>;
  fetcher: Pick<SafeFetcher, 'fetchPage'>;
  dns: DnsLike;
  smartlead: SmartleadAdapter;
}

function build(): Adapters {
  const graph = new MicrosoftGraphProvider();
  const oauth: Adapters['oauth'] = {};
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) oauth.GMAIL = new GoogleOAuthClient(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) oauth.MICROSOFT = new MicrosoftOAuthClient(process.env.MICROSOFT_CLIENT_ID, process.env.MICROSOFT_CLIENT_SECRET, process.env.MICROSOFT_TENANT ?? 'common');
  return {
    email: { GMAIL: new GmailProvider(), MICROSOFT: graph, SMTP_IMAP: new SmtpImapProvider() },
    oauth,
    graphSubscriptions: graph,
    ai: { OPENAI: new OpenAiAdapter(), ANTHROPIC: new AnthropicAdapter() },
    leadData: { apollo: new ApolloProvider() },
    verifiers: { millionverifier: new MillionVerifierProvider(), zerobounce: new ZeroBounceProvider(), neverbounce: new NeverBounceProvider() },
    finders: { hunter: new HunterFinder() },
    dnsProviders: { cloudflare: new CloudflareDns() },
    search: { brave: new BraveSearchProvider(), serper: new SerperSearchProvider() },
    fetcher: new SafeFetcher(),
    dns: dnsPromises,
    smartlead: new SmartleadAdapter(),
  };
}

let current: Adapters | null = null;
export function adapters(): Adapters {
  if (!current) current = build();
  return current;
}
export function setAdapters(partial: Partial<Adapters>) {
  current = { ...adapters(), ...partial };
}
export function resetAdapters() { current = null; }
