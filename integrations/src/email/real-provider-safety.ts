/** The browser fixture must never construct a real transport, including direct callers. */
export function assertRealEmailProviderAllowed() {
  if (process.env.OUTVEXA_BROWSER_E2E !== undefined || process.env.DATABASE_URL?.includes('/outvexa_browser_e2e')) {
    throw new Error('Real email provider initialization is blocked in browser E2E');
  }
}
