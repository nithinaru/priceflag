import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Price writes and the evaluator run in Node (crypto, pg advisory locks) — never edge.
  serverExternalPackages: ['@supabase/supabase-js'],
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            // Embedded app: the Shopify admin must be allowed to frame every
            // page, and `frame-ancestors` is also what suppresses any implicit
            // X-Frame-Options (which would deny embedding outright). The
            // eventual right answer is a dynamic per-shop value
            // (`https://{shop} https://admin.shopify.com`); the wildcard is
            // accepted by Shopify for embedded custom apps and fine for the beta.
            key: 'Content-Security-Policy',
            value: 'frame-ancestors https://admin.shopify.com https://*.myshopify.com;',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
