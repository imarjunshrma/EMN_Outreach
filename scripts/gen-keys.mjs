// Prints fresh secrets for .env. Run: npm run gen-keys
import { randomBytes } from 'node:crypto';
console.log(`SESSION_SECRET=${randomBytes(48).toString('base64url')}`);
console.log(`ENCRYPTION_KEYS=1:${randomBytes(32).toString('base64')}`);
console.log('ENCRYPTION_ACTIVE_KEY=1');
