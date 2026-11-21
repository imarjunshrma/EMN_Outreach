// Server-side password reset (there is no reset email: the app sends no system mail).
// Usage (on the server): cd /opt/emn/current && sudo -u emn EMN_NEW_PASSWORD='...' npm run reset-password -- --email user@company.com
// Revokes all of the user's sessions and writes an audit entry.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createPrisma, setDbForTests } from '../backend/src/core/db.js';
import { hashPassword, validatePasswordStrength } from '../backend/src/services/auth.js';
import { audit } from '../backend/src/core/audit.js';

try { process.loadEnvFile(process.env.EMN_ENV_FILE ?? '.env'); } catch { /* optional */ }
const i = process.argv.indexOf('--email');
const email = i > -1 ? String(process.argv[i + 1] ?? '').toLowerCase() : '';
if (!email) { console.error('Usage: npm run reset-password -- --email <email>'); process.exit(1); }

let password = process.env.EMN_NEW_PASSWORD;
if (!password) {
  const rl = createInterface({ input: stdin, output: stdout });
  password = await rl.question('New password (min 12 chars, letters + numbers): ');
  rl.close();
}
validatePasswordStrength(password);

const prisma = createPrisma(process.env.DATABASE_URL!);
setDbForTests(prisma);
const user = await prisma.user.findUnique({ where: { email } });
if (!user) { console.error(`No user with email ${email}`); process.exit(1); }
await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
const revoked = await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
await audit(null, { type: 'SYSTEM' }, 'user.password_reset_cli', { type: 'user', id: user.id });
console.log(`Password reset for ${email}; ${revoked.count} session(s) revoked.`);
await prisma.$disconnect();
