/**
 * Import the EMN organization seed into a test workspace or explicitly selected existing workspace.
 * Preview is the default. Pass --apply and --workspace <test-slug-or-id> for an empty test workspace,
 * or --apply-existing and --workspace-name <exact name> for a reviewed existing workspace.
 * This command never configures providers/mailboxes, creates leads/campaigns or sends mail.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createPrisma, Prisma } from '../backend/src/core/db.js';
import { audit, SYSTEM_ACTOR } from '../backend/src/core/audit.js';
import { KnowledgeSchema, ResearchSchema, WritingSchema } from '../shared/src/ai-studio.js';
import { IcpCriteriaSchema } from '../shared/src/ai-schemas.js';

try { process.loadEnvFile('.env'); } catch { /* optional; DATABASE_URL is required only when applying */ }

const SeedSchema = z.object({
  seed_name: z.string().min(1),
  seed_version: z.string().min(1),
  sender: z.object({ name: z.string(), title: z.string(), company: z.string(), company_legal_operator_wording: z.string(), website: z.string(), sender_email: z.string().email(), signature_rules: z.array(z.string()) }),
  company: z.object({ name: z.string(), preferred_description: z.string(), positioning: z.string(), credibility: z.array(z.string()), services: z.array(z.object({ name: z.string(), description: z.string() })) }),
  ideal_customer_profile: z.object({
    primary: z.array(z.object({ segment: z.string(), fit_signals: z.array(z.string()) })),
    secondary: z.array(z.string()),
    geographies: z.object({ priority: z.array(z.string()), selective: z.array(z.string()), rule: z.string() }),
    strong_buying_signals: z.array(z.string()), low_fit_or_exclude: z.array(z.string()), qualification_rule: z.string(),
  }),
  writing_playbook: z.object({
    workflow_order: z.array(z.string()), core_framework: z.array(z.string()),
    style: z.object({ language: z.string(), voice: z.string(), point_of_view: z.string(), length: z.string(), paragraphs: z.string(), personalization: z.string() }),
    must_do: z.array(z.string()), must_not_do: z.array(z.string()), cta_guidance: z.array(z.string()),
    subject_line: z.object({ requirements: z.array(z.string()) }),
  }),
  research_instructions: z.object({
    principle: z.string(), sources_to_check_when_available: z.array(z.string()), research_fields: z.array(z.string()),
    evidence_rules: z.array(z.string()), research_freshness: z.string(), qualification_outcomes: z.array(z.string()),
  }),
  service_matching: z.record(z.string(), z.string()),
}).passthrough();

type Seed = z.infer<typeof SeedSchema>;

function argsOf(argv: string[]) {
  const out: { file?: string; workspace?: string; workspaceName?: string; apply: boolean; applyExisting: boolean } = { apply: false, applyExisting: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--apply') out.apply = true;
    else if (arg === '--apply-existing') { out.apply = true; out.applyExisting = true; }
    else if (arg === '--file' || arg === '--workspace' || arg === '--workspace-name') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--file') out.file = value;
      else if (arg === '--workspace') out.workspace = value;
      else out.workspaceName = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run seed:emn -- --file <seed.json> [--workspace <test-slug-or-id> --apply | --workspace-name <exact-name> --apply-existing]\nPreview is the default. Existing workspaces receive new active config versions; old versions are retained.');
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!out.file) throw new Error('Pass --file <seed.json>.');
  if (out.applyExisting && (out.workspace || !out.workspaceName)) throw new Error('--apply-existing requires --workspace-name <exact workspace name> and cannot be combined with --workspace.');
  if (out.apply && !out.applyExisting && (!out.workspace || out.workspaceName)) throw new Error('--apply requires --workspace <empty test workspace slug-or-id>.');
  if (!out.apply && out.workspace) throw new Error('--workspace is only accepted with --apply; preview does not connect to a database.');
  if (out.workspaceName && !out.applyExisting && out.apply) throw new Error('--workspace-name can only be used with --apply-existing.');
  return out;
}

function bullets(values: string[]) { return values.map((x) => `- ${x}`).join('\n'); }

function mapSeed(seed: Seed) {
  const audience = [
    ...seed.ideal_customer_profile.primary.map((x) => `${x.segment}: ${x.fit_signals.join(' ')}`),
    ...seed.ideal_customer_profile.secondary,
  ].join('\n');
  const knowledge = KnowledgeSchema.parse({
    companyName: seed.company.name,
    website: seed.sender.website,
    description: `${seed.company.preferred_description}\n${seed.company.positioning}`,
    services: seed.company.services,
    achievements: seed.company.credibility.map((text) => ({ text, source: '', verified: false })),
    targetAudience: audience,
    customerProfiles: `${seed.ideal_customer_profile.geographies.rule}\nPriority: ${seed.ideal_customer_profile.geographies.priority.join(', ')}. Selective: ${seed.ideal_customer_profile.geographies.selective.join(', ')}.`,
  });

  const p = seed.writing_playbook;
  const writing = WritingSchema.parse({
    tone: 'consultative', formality: 'neutral', language: 'English',
    minWords: 30, maxWords: 100, personalizationIntensity: 'deep', ctaStyle: 'soft_question',
    style: [p.style.language, p.style.voice, p.style.point_of_view, p.style.length, p.style.paragraphs, p.style.personalization, `Framework: ${p.core_framework.join(' → ')}.`].join(' '),
    avoidPhrases: [...p.must_not_do.filter((x) => /generic praise|came across|thanks for connecting|\bBest\b|Calendly|personal branding|digital marketing/i.test(x)), 'I don’t have a specific observation', "I don't have a specific observation"],
    forbiddenClaims: [
      'guaranteed views', 'guaranteed leads', 'guaranteed revenue', 'guaranteed rankings', 'guaranteed conversions',
      'unsupported results', 'unsupported client claims', 'invented pain points', 'invented intent',
    ],
    customInstructions: [
      'EMN SEED RULES (adapted to the application’s native output schema; do not replace that schema):',
      `Workflow: ${p.workflow_order.join(' → ')}`,
      `Core framework: ${p.core_framework.join(' → ')}.`,
      `Sender context: ${seed.sender.name}, ${seed.sender.title}, ${seed.sender.company}. Use the sending mailbox configured in the application as the actual From address.`,
      `Service matching guidance:\n${Object.entries(seed.service_matching).map(([name, guidance]) => `- ${name}: ${guidance}`).join('\n')}`,
      'Use one verified, recent or clearly relevant observation only when supplied in evidence-backed prospect claims. Explain its relevance briefly, connect it to one supported EMN capability, then ask one easy question.',
      'Never invent prospect facts, achievements, pain points, business intent, dates, metrics or source claims. Do not force personalization when evidence is weak.',
      'Do not include a signature or Calendly URL in the body. The application controls sender identity, compliance footer and unsubscribe link.',
      'Must do:', bullets(p.must_do), 'Must not do:', bullets(p.must_not_do), 'CTA guidance:', bullets(p.cta_guidance), 'Subject rules:', bullets(p.subject_line.requirements),
    ].join('\n\n'),
  });

  const r = seed.research_instructions;
  const research = ResearchSchema.parse({
    personTopics: r.research_fields.filter((x) => /person|role|profile|posts|interview|speaker|author/i.test(x)).slice(0, 30),
    companyTopics: r.research_fields.filter((x) => /company|offer|business|content|distribution|objective/i.test(x)).slice(0, 30),
    signals: seed.ideal_customer_profile.strong_buying_signals,
    minClaims: 1,
    maxEvidenceAgeDays: 365,
    onMissing: 'hold_for_research',
    customInstructions: [r.principle, `Sources to check when available:\n${bullets(r.sources_to_check_when_available)}`, `Research fields:\n${bullets(r.research_fields)}`, `Evidence rules:\n${bullets(r.evidence_rules)}`, r.research_freshness, `Qualification outcomes: ${r.qualification_outcomes.join(', ')}.`, 'If no useful trigger is verified, do not invent one; hold the lead for research instead of generating campaign personalization.'].join('\n\n'),
  });

  const icpDescription = [
    ...seed.ideal_customer_profile.primary.map((x) => `${x.segment}: ${x.fit_signals.join(' ')}`),
    ...seed.ideal_customer_profile.secondary,
  ].join('\n');
  const countryCode: Record<string, string> = { 'United States': 'US', 'United Kingdom': 'GB', Australia: 'AU', India: 'IN' };
  const criteria = IcpCriteriaSchema.parse({
    countries: seed.ideal_customer_profile.geographies.priority.map((x) => countryCode[x]).filter(Boolean),
    keywords: seed.ideal_customer_profile.primary.map((x) => x.segment).concat(seed.ideal_customer_profile.secondary),
    mustHave: seed.ideal_customer_profile.strong_buying_signals,
    disqualifiers: seed.ideal_customer_profile.low_fit_or_exclude,
  });
  const icpInstructions = [seed.ideal_customer_profile.qualification_rule, seed.ideal_customer_profile.geographies.rule, `Selective geographies: ${seed.ideal_customer_profile.geographies.selective.join(', ')}.`, ...seed.ideal_customer_profile.primary.map((x) => `${x.segment}: ${x.fit_signals.join(' ')}`)].join('\n');
  const icp = { name: `EMN Seed ${seed.seed_version} — Primary ICP`, description: icpDescription, criteria, minScore: 60, isActive: true, aiInstructions: icpInstructions };
  return { knowledge, writing, research, icp };
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const filePath = path.resolve(args.file!);
  const raw = await readFile(filePath, 'utf8');
  let json: unknown;
  try { json = JSON.parse(raw); } catch (e) { throw new Error(`Seed file is not valid JSON: ${(e as Error).message}`, { cause: e }); }
  const parsed = SeedSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Seed file does not match the expected EMN seed structure: ${parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const seed = parsed.data;
  const mapped = mapSeed(seed);
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const note = `EMN seed ${seed.seed_version} import sha256:${hash}`;
  mapped.icp.name = `EMN Seed ${seed.seed_version} — Primary ICP (${hash.slice(0, 8)})`;

  console.log(`Seed: ${seed.seed_name} (${seed.seed_version})`);
  console.log(`File: ${filePath}`);
  console.log(`Fingerprint: ${hash}`);
  console.log('Mapped settings: Business Knowledge, Writing, Research, one EMN ICP.');
  console.log('Safety: no provider keys, mailbox credentials, sender email, campaigns, leads or sends are changed.');
  console.log('Unverified credibility claims remain marked unverified. App-native output schemas remain unchanged.');
  console.log(`ICP: ${mapped.icp.name}; priority countries: ${mapped.icp.criteria.countries.join(', ') || '(none mapped)'}`);
  console.log(`Research: minClaims=${mapped.research.minClaims}; onMissing=${mapped.research.onMissing}; maxEvidenceAgeDays=${mapped.research.maxEvidenceAgeDays}`);
  if (args.workspaceName) console.log(`Requested exact workspace name: ${args.workspaceName}`);
  if (!args.apply) {
    console.log('\nDRY RUN ONLY — no database connection or writes occurred.');
    console.log('Test workspace command (empty test/seed workspace only):');
    console.log(`npm run seed:emn -- --file ${JSON.stringify(filePath)} --workspace <test-workspace-slug-or-id> --apply`);
    console.log('Existing workspace command (new settings become active; prior versions are retained):');
    console.log(`npm run seed:emn -- --file ${JSON.stringify(filePath)} --workspace-name ${JSON.stringify(args.workspaceName ?? 'Elite Media')} --apply-existing`);
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. No changes were made.');
  const prisma = createPrisma(databaseUrl);
  try {
    let ws;
    if (args.applyExisting) {
      const matches = await prisma.workspace.findMany({ where: { name: args.workspaceName }, select: { id: true, name: true, slug: true }, take: 2 });
      if (matches.length !== 1) throw new Error(`Expected one workspace named “${args.workspaceName}”, found ${matches.length}. No changes were made; use an exact unique name.`);
      ws = matches[0]!;
    } else {
      const workspaceRef = args.workspace!;
      const isUuid = z.string().uuid().safeParse(workspaceRef).success;
      ws = await prisma.workspace.findFirst({ where: isUuid ? { id: workspaceRef } : { slug: workspaceRef }, select: { id: true, name: true, slug: true } });
      if (!ws) throw new Error(`Workspace “${workspaceRef}” was not found. No changes were made.`);
      if (!/(test|seed)/i.test(ws.slug)) throw new Error(`Refusing to write to workspace “${ws.slug}”. The target slug must contain “test” or “seed”.`);
      const [leads, campaigns, mailboxes] = await Promise.all([
        prisma.lead.count({ where: { workspaceId: ws.id } }),
        prisma.campaign.count({ where: { workspaceId: ws.id } }),
        prisma.emailAccount.count({ where: { workspaceId: ws.id } }),
      ]);
      if (leads || campaigns || mailboxes) throw new Error(`Workspace must be empty of leads, campaigns and mailboxes (found ${leads}, ${campaigns}, ${mailboxes}). No changes were made.`);
    }

    const configVersions = await prisma.aiConfigVersion.findMany({ where: { workspaceId: ws.id }, select: { kind: true, changeNote: true, isActive: true } });
    const existingIcp = await prisma.idealCustomerProfile.findUnique({ where: { workspaceId_name: { workspaceId: ws.id, name: mapped.icp.name } } });
    const alreadyImported = (['KNOWLEDGE', 'WRITING', 'RESEARCH'] as const).every((kind) => configVersions.some((v) => v.kind === kind && v.isActive && v.changeNote === note))
      && !!existingIcp && existingIcp.aiInstructions === `${mapped.icp.aiInstructions}\n\n${note}`;
    if (alreadyImported) {
      console.log(`This seed is already active in ${ws.name} (${ws.slug}); no changes made.`);
      return;
    }
    if (configVersions.some((v) => v.changeNote === note)) throw new Error('A previous import of this seed exists but is no longer active in all three settings. No changes made; review AI Studio version history first.');
    if (!args.applyExisting && (configVersions.length || existingIcp)) throw new Error('Target test workspace already has AI configuration or the seed ICP. Use a fresh empty test workspace; this importer will not replace existing settings.');
    if (existingIcp) throw new Error(`The target already has an ICP named “${mapped.icp.name}”. No changes were made.`);

    await prisma.$transaction(async (tx) => {
      for (const [kind, data] of [['KNOWLEDGE', mapped.knowledge], ['WRITING', mapped.writing], ['RESEARCH', mapped.research]] as const) {
        const last = await tx.aiConfigVersion.findFirst({ where: { workspaceId: ws.id, kind }, orderBy: { version: 'desc' }, select: { version: true } });
        const version = (last?.version ?? 0) + 1;
        await tx.aiConfigVersion.updateMany({ where: { workspaceId: ws.id, kind, isActive: true }, data: { isActive: false } });
        await tx.aiConfigVersion.create({ data: { workspaceId: ws.id, kind, version, data: data as Prisma.InputJsonValue, isActive: true, changeNote: note } });
      }
      await tx.idealCustomerProfile.create({ data: { ...mapped.icp, workspaceId: ws.id, aiInstructions: `${mapped.icp.aiInstructions}\n\n${note}`, criteria: mapped.icp.criteria as Prisma.InputJsonValue } });
    });
    await audit(ws.id, SYSTEM_ACTOR, 'ai_studio.seed_imported', undefined, { seedVersion: seed.seed_version, fingerprint: hash, configKinds: ['KNOWLEDGE', 'WRITING', 'RESEARCH'], icp: mapped.icp.name });
    console.log(`Applied seed to ${ws.name} (${ws.slug}).`);
    console.log('No mailbox, provider key, lead, campaign or outbound message was changed or created.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`EMN seed import stopped: ${(e as Error).message}`);
  process.exitCode = 1;
});
