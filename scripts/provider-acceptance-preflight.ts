try { process.loadEnvFile(process.env.EMN_ENV_FILE ?? '.env'); } catch { /* test deployment may inject environment */ }

const providers = {
  Gmail: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OUTVEXA_ACCEPTANCE_GMAIL'],
  Graph: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT', 'OUTVEXA_ACCEPTANCE_GRAPH'],
  'SMTP/IMAP': ['OUTVEXA_ACCEPTANCE_SMTP'],
};
const requested = process.argv[2];
const selected = Object.entries(providers).filter(([provider]) => !requested || requested === provider);
if (!selected.length) throw new Error('Select Gmail, Graph, or SMTP/IMAP.');
for (const [provider, variables] of selected) {
  const missing = [...variables, 'OUTVEXA_ACCEPTANCE_RECIPIENT', 'OUTVEXA_ACCEPTANCE_APPROVAL_REF']
    .filter(key => !process.env[key]?.trim());
  const appUrl = process.env.APP_URL;
  try {
    const url = new URL(appUrl ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) missing.push('APP_URL (isolated HTTPS origin)');
  } catch { missing.push('APP_URL (isolated HTTPS origin)'); }
  console.log(JSON.stringify({ provider, configurationComplete: !missing.length, missing, liveTestExecuted: false }));
  if (missing.length) process.exitCode = 1;
}
