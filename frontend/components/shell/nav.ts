import {
  BarChart3, Bell, BookOpen, Bot, BrainCircuit, Building2, ClipboardCheck, Cog, CreditCard, Cpu, Database, FileBarChart, FileSearch, Globe, HeartPulse, Inbox, KanbanSquare,
  KeyRound, LayoutDashboard, Library, ListTodo, Mail, MailCheck, MessageSquareReply, PenLine, Plug, Scale, ScrollText, Send, Settings, ShieldBan, ShieldCheck,
  SlidersHorizontal, Sparkles, Target, Telescope, Upload, UserCircle, Users, UsersRound, Webhook, Workflow, Zap, AlertTriangle, type LucideIcon,
} from 'lucide-react';

export interface NavItem { href: string; label: string; icon: LucideIcon; minRole?: string; keywords?: string }
export interface NavGroup { group: string; items: NavItem[] }

// Ordered the way the work flows: find people → write → send → handle replies → close.
export const NAV: NavGroup[] = [
  { group: 'Home', items: [
    { href: '', label: 'Dashboard', icon: LayoutDashboard, keywords: 'home overview today' },
    { href: '/copilot', label: 'AI Copilot', icon: Bot, keywords: 'assistant ask chat' },
    { href: '/notifications', label: 'Notifications', icon: Bell },
  ] },
  { group: 'Prospects', items: [
    { href: '/prospecting', label: 'Prospect discovery', icon: Telescope, keywords: 'apollo search find' },
    { href: '/leads', label: 'Leads', icon: Users, keywords: 'contacts people' },
    { href: '/companies', label: 'Companies', icon: Building2, keywords: 'accounts' },
    { href: '/leads/import', label: 'Import & export', icon: Upload, keywords: 'csv upload' },
    { href: '/research', label: 'Research', icon: FileSearch, keywords: 'evidence web' },
    { href: '/enrichment', label: 'Verification', icon: MailCheck, keywords: 'enrichment waterfall verify finder hunter' },
    { href: '/icps', label: 'Ideal customer profile', icon: Target, keywords: 'icp' },
  ] },
  { group: 'Outreach', items: [
    { href: '/campaigns', label: 'Campaigns', icon: Send, keywords: 'sequences' },
    { href: '/writing', label: 'Writing studio', icon: PenLine, keywords: 'ai email' },
    { href: '/followups', label: 'Review queue', icon: ClipboardCheck, keywords: 'approve followups' },
    { href: '/inbox', label: 'Inbox', icon: Inbox, keywords: 'replies unibox' },
    { href: '/reply-assistant', label: 'Reply assistant', icon: MessageSquareReply, keywords: 'drafts templates auto' },
  ] },
  { group: 'AI Outreach Brain', items: [
    { href: '/ai-studio', label: 'Overview', icon: Sparkles },
    { href: '/ai-studio/training', label: 'Outreach training', icon: BrainCircuit, keywords: 'strategy rules examples learning feedback' },
    { href: '/ai-studio/knowledge', label: 'Business knowledge', icon: BookOpen },
    { href: '/ai-studio/imports', label: 'Knowledge importer', icon: Upload },
    { href: '/ai-studio/writing', label: 'Writing rules', icon: SlidersHorizontal },
    { href: '/ai-studio/research', label: 'Research rules', icon: FileSearch },
    { href: '/ai-studio/profiles', label: 'Prompt library', icon: Library },
    { href: '/ai-studio/models', label: 'Models & budgets', icon: Cpu, minRole: 'ADMIN' },
  ] },
  { group: 'Pipeline', items: [
    { href: '/pipeline', label: 'Deals & forecast', icon: KanbanSquare, keywords: 'crm opportunities' },
    { href: '/tasks', label: 'Tasks', icon: ListTodo, keywords: 'reminders' },
    { href: '/workflows', label: 'Workflows', icon: Workflow, keywords: 'automation builder' },
    { href: '/automations', label: 'Simple rules', icon: Zap, keywords: 'automations' },
    { href: '/analytics', label: 'Analytics', icon: BarChart3 },
    { href: '/reports', label: 'Reports & alerts', icon: FileBarChart, keywords: 'slack scheduled' },
  ] },
  { group: 'Deliverability', items: [
    { href: '/intelligent-sending', label: 'Intelligent Sending', icon: SlidersHorizontal, minRole: 'ADMIN' },
    { href: '/email-accounts', label: 'Mailboxes', icon: Mail, keywords: 'gmail outlook smtp connect' },
    { href: '/mailbox-health', label: 'Mailbox health', icon: HeartPulse },
    { href: '/warmup', label: 'Warm-up', icon: MailCheck, minRole: 'ADMIN', keywords: 'mailbox health controlled sending' },
    { href: '/domains', label: 'Domains', icon: Globe, keywords: 'dns spf dkim dmarc' },
    { href: '/settings/suppression', label: 'Suppression list', icon: ShieldBan, keywords: 'unsubscribe blocklist' },
    { href: '/settings/compliance', label: 'Compliance', icon: Scale, keywords: 'countries gdpr' },
  ] },
  { group: 'Settings', items: [
    { href: '/settings/general', label: 'Workspace', icon: Settings, keywords: 'sender address' },
    { href: '/settings/outreach', label: 'Outreach automation', icon: Send, minRole: 'ADMIN', keywords: 'emergency pause sending followups limits scheduler' },
    { href: '/settings/email-verification', label: 'Email verification', icon: MailCheck, minRole: 'ADMIN', keywords: 'first-party unknown disposable freshness smtp' },
    { href: '/settings/team', label: 'Team', icon: UsersRound, keywords: 'members invite' },
    { href: '/settings/policies', label: 'Security & AI policies', icon: ShieldCheck, minRole: 'ADMIN', keywords: '2fa reply mode' },
    { href: '/settings/ai', label: 'AI providers', icon: Cpu, minRole: 'ADMIN', keywords: 'openai anthropic keys prompts' },
    { href: '/settings/integrations', label: 'Integrations', icon: Plug, minRole: 'ADMIN', keywords: 'apollo cloudflare zerobounce' },
    { href: '/billing', label: 'Plan & billing', icon: CreditCard },
    { href: '/usage', label: 'Usage & cost', icon: Database },
    { href: '/settings/api-keys', label: 'API keys', icon: KeyRound, minRole: 'ADMIN' },
    { href: '/settings/webhooks', label: 'Webhooks', icon: Webhook, minRole: 'ADMIN' },
    { href: '/settings/audit', label: 'Audit log', icon: ScrollText, minRole: 'ADMIN' },
    { href: '/settings/jobs', label: 'Background jobs', icon: Cog, minRole: 'ADMIN' },
    { href: '/settings/logs', label: 'Error log', icon: AlertTriangle, minRole: 'ADMIN' },
    { href: '/settings/privacy', label: 'Data & privacy', icon: ShieldBan, minRole: 'ADMIN', keywords: 'export erase' },
    { href: '/settings/account', label: 'My account', icon: UserCircle, keywords: 'password 2fa theme' },
  ] },
];

export const RANK: Record<string, number> = { VIEWER: 0, MEMBER: 1, MANAGER: 2, ADMIN: 3, OWNER: 4 };
export const visibleNav = (role: string) => NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.minRole || RANK[role] >= RANK[i.minRole]) })).filter((g) => g.items.length);
