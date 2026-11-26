import { assertWarmupTestSafety, mockWarmupEmail } from './warmup-test-safety.js';
import { ZeroBounceProvider, NeverBounceProvider, HunterFinder, CloudflareDns, type EmailFinder, type DnsProviderAdapter } from '../../../integrations/src/providers/extra.js';
import { AnthropicAdapter } from '../../../integrations/src/ai/anthropic.js';
import { OpenAiAdapter } from '../../../integrations/src/ai/openai.js';
import { GoogleAiAdapter } from '../../../integrations/src/ai/google.js';
import { AI_PROVIDER_BASE_URLS, OpenAiCompatibleAdapter } from '../../../integrations/src/ai/openai-compatible.js';
import { AI_PROVIDER_NAMES, type AiProviderAdapter, type AiProviderName } from '../../../integrations/src/ai/types.js';
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
import { logger } from './logger.js';

// Composition root. Tests replace adapters with fakes via setAdapters().

export interface Adapters {
  email: Record<EmailProviderName, EmailProvider>;
  oauth: Partial<Record<'GMAIL' | 'MICROSOFT', OAuthClient>>;
  graphSubscriptions: ChangeSubscriptionProvider | null;
  ai: Partial<Record<AiProviderName, AiProviderAdapter>>;
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
  assertWarmupTestSafety();
  const mock = process.env.OUTVEXA_EMAIL_MODE === 'mock';
  const graph = mock ? null : new MicrosoftGraphProvider();
  const oauth: Adapters['oauth'] = {};
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) oauth.GMAIL = new GoogleOAuthClient(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) oauth.MICROSOFT = new MicrosoftOAuthClient(process.env.MICROSOFT_CLIENT_ID, process.env.MICROSOFT_CLIENT_SECRET, process.env.MICROSOFT_TENANT ?? 'common');
  return {
    email: graph
      ? { GMAIL: new GmailProvider(), MICROSOFT: graph, SMTP_IMAP: new SmtpImapProvider() }
      : { GMAIL: mockWarmupEmail('GMAIL'), MICROSOFT: mockWarmupEmail('MICROSOFT'), SMTP_IMAP: mockWarmupEmail('SMTP_IMAP') },
    oauth,
    graphSubscriptions: graph,
    ai: Object.fromEntries(AI_PROVIDER_NAMES.map((name) => [name,
      name === 'OPENAI' ? new OpenAiAdapter()
        : name === 'ANTHROPIC' ? new AnthropicAdapter()
          : name === 'GOOGLE' ? new GoogleAiAdapter()
            : new OpenAiCompatibleAdapter(name, AI_PROVIDER_BASE_URLS[name] ?? 'https://api.openai.com/v1'),
    ])) as unknown as Record<AiProviderName, AiProviderAdapter>,
    leadData: { apollo: new ApolloProvider() },
    verifiers: { millionverifier: new MillionVerifierProvider(), zerobounce: new ZeroBounceProvider(), neverbounce: new NeverBounceProvider() },
    finders: { hunter: new HunterFinder() },
    dnsProviders: { cloudflare: new CloudflareDns() },
    search: { brave: new BraveSearchProvider(), serper: new SerperSearchProvider() },
    fetcher: new SafeFetcher(undefined, undefined, undefined, (entry) => logger.warn(entry, 'public website fetch rejected')),
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
