// Writes docs/openapi.json from the live route registry.
import { writeFileSync } from 'node:fs';
process.env.DATABASE_URL ??= 'postgresql://unused@127.0.0.1/unused';
const { routes } = await import('../backend/src/http/router.js');
await import('../backend/src/app.js');
const { buildOpenApi } = await import('../backend/src/http/openapi.js');
const doc = buildOpenApi(routes);
writeFileSync('docs/openapi.json', JSON.stringify(doc, null, 2));
// The documentation site renders the API reference from this copy (the frontend build cannot see ../docs).
writeFileSync('frontend/content/openapi.json', JSON.stringify(doc));
console.log(`wrote docs/openapi.json (${Object.keys(doc.paths).length} paths, ${routes.length} operations)`);
process.exit(0);
