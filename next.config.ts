import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Price writes and the evaluator run in Node (crypto, pg advisory locks) — never edge.
  serverExternalPackages: ['@supabase/supabase-js'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
