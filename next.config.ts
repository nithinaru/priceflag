import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    viewTransition: true,
  },
  transpilePackages: ['metal-fx', 'liquid-gooey', 'animejs'],
  // Price writes and the evaluator run in Node (crypto, pg advisory locks) — never edge.
  serverExternalPackages: ['@supabase/supabase-js'],
  // The development machine has another lockfile above this repository. Pin the
  // trace root so production bundles never infer or include a parent workspace.
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  // Hide the Next.js “N” badge in local/dev overlays.
  devIndicators: false,
  eslint: { ignoreDuringBuilds: true },
  async redirects() {
    // These only fire when the host is bound to this project (`priceflag-app`).
    // `signin.priceflag.org` still lives on `priceflagv1` until it is moved;
    // `product.priceflag.org` has no DNS yet. See PILOT_RUNBOOK.md.
    const dashboard = 'https://dashboard.priceflag.org';
    const aliasHosts = ['signin.priceflag.org', 'product.priceflag.org'] as const;
    return aliasHosts.flatMap((host) => {
      const onHost = { type: 'host' as const, value: host };
      return [
        {
          source: '/auth/callback',
          has: [onHost],
          destination: `${dashboard}/auth/callback`,
          permanent: true,
        },
        {
          source: '/api/auth/callback',
          has: [onHost],
          destination: `${dashboard}/api/auth/callback`,
          permanent: true,
        },
        {
          source: '/',
          has: [onHost],
          destination: `${dashboard}/signin`,
          permanent: true,
        },
        {
          source: '/:path*',
          has: [onHost],
          destination: `${dashboard}/signin`,
          permanent: true,
        },
      ];
    });
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            // Embedded custom app: Shopify Admin and the owning shop may frame
            // the UI. Merchant APIs still require fresh session tokens.
            key: 'Content-Security-Policy',
            value: 'frame-ancestors https://admin.shopify.com https://*.myshopify.com;',
          },
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
