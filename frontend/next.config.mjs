/** @type {import('next').NextConfig} */
const API = process.env.EMN_API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
// `next dev` needs eval for React Refresh / source maps; production builds keep the strict policy.
const DEV_EVAL = process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'";
const nextConfig = {
  reactStrictMode: true,
  // Separate build dirs let the browser-test build (different API URL baked into rewrites) coexist with the real one.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  // In production Nginx routes /api to the backend directly; this rewrite serves local development.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      // Next.js App Router injects inline bootstrap scripts, so 'unsafe-inline' is required for scripts
      // without a nonce pipeline; everything else is locked to this origin.
      { key: 'Content-Security-Policy', value: `default-src 'self'; script-src 'self' 'unsafe-inline'${DEV_EVAL}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ] }];
  },
};
export default nextConfig;
