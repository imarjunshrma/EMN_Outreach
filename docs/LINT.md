# Source lint

Run `npm run lint` from the repository root. The root flat configuration includes maintained backend, frontend, worker, shared, integration, scripts, and test source. Frontend source also uses React Hooks checks and the Next image rule.

For an individual package or test scope, run `npx eslint backend`, `npx eslint frontend`, `npx eslint worker`, `npx eslint shared`, `npx eslint tests e2e`, or pass a list of changed files.

The exclusions cover dependencies, emitted bundles and generated declarations, Prisma-generated backend code, test output, uploaded storage, application session caches, and duplicate local-development copies. Type checks and builds run independently.
