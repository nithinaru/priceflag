import type { NextRequest } from 'next/server';

import { env } from './config';
import { safeEqual } from './crypto';

/**
 * Authenticate the server-to-server ML pipeline.
 *
 * The pipeline already needs write authority for validated model outputs, so
 * the same high-entropy credential protects its narrower read surface. Keeping
 * one credential also makes rotation atomic: a worker can never retain read
 * access after its ingest authority has been revoked.
 */
export function isMlPipelineAuthorised(request: NextRequest): boolean {
  const secret = env('ML_INGEST_SECRET');
  if (secret === undefined) return false;
  const header = request.headers.get('authorization');
  if (header === null) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match !== null && safeEqual(match[1] as string, secret);
}
