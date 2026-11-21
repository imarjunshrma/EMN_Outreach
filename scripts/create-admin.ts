// Creates the first owner account + workspace from the command line (alternative to the web setup page).
// Usage: npm run create-admin -- --email you@company.com --name "Your Name" --workspace "Elite Media Networks"
// The password is read from the EMN_ADMIN_PASSWORD env var or prompted interactively.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createPrisma, setDbForTests } from '../backend/src/core/db.js';
import { hashPassword, validatePasswordStrength } from '../backend/src/services/auth.js';

try { process.loadEnvFile('.env'); } catch { /* optional */ }
const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
if (!args.email || !args.name || !args.workspace) {
  console.error('Usage: npm run create-admin -- --email <email> --name "<name>" --workspace "<workspace name>"');
  process.exit(1);
}
let password = process.env.EMN_ADMIN_PASSWORD;
if (!password) {
  const rl = createInterface({ input: stdin, output: stdout });
  password = await rl.question('Password (min 12 chars, letters + numbers): ');
  rl.close();
}
validatePasswordStrength(password);
const prisma = createPrisma(process.env.DATABASE_URL!);
setDbForTests(prisma);
const email = String(args.email).toLowerCase();
if (await prisma.user.findUnique({ where: { email } })) { console.error('User already exists'); process.exit(1); }
const user = await prisma.user.create({ data: { email, name: args.name, passwordHash: await hashPassword(password), isPlatformAdmin: true, platformRole: 'SUPER_ADMIN', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() } });
const { provisionTenant } = await import('../backend/src/services/tenancy.js');
const { organization, workspace: ws } = await provisionTenant({ userId: user.id, organizationName: args.workspace });
console.log(`Created platform admin ${email} owning organization "${organization.name}" with workspace ${ws.id}`);
await prisma.$disconnect();
