import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Price writes and the evaluator run in Node (crypto, pg advisory locks) — never edge.
  serverExternalPackages: ['@supabase/supabase-js'],
  // The development machine has another lockfile above this repository. Pin the
  // trace root so production bundles never infer or include a parent workspace.
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default nextConfig;
