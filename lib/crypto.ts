/**
 * Encryption for Shopify access tokens at rest (R23).
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt instead
 * of yielding garbage that we then send to Shopify as a bearer token. The
 * version prefix exists so the key can be rotated later without guessing at the
 * format of old rows.
 *
 * Server only — importing this into a client component is a bug.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;

/** Parse `ENCRYPTION_KEY`: 32 bytes as base64 (44 chars) or hex (64 chars). */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === '') {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        'Use 32 random bytes as base64 or hex.',
    );
  }
  return key;
}

function keyFromEnv(explicit?: string): Buffer {
  return parseEncryptionKey(explicit ?? process.env.ENCRYPTION_KEY);
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64. */
export function encryptSecret(plaintext: string, keyRaw?: string): string {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new TypeError('refusing to encrypt an empty secret');
  }
  const key = keyFromEnv(keyRaw);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptSecret(payload: string, keyRaw?: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`unrecognised encrypted payload (expected ${VERSION}.<iv>.<tag>.<ct>)`);
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];

  const key = keyFromEnv(keyRaw);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  // Throws on a wrong key or tampered ciphertext, which is the point.
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${VERSION}.`) && value.split('.').length === 4;
}

/** For `.env.example` docs and the runbook. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Constant-time comparison for shared secrets (CRON_SECRET, and the webhook
 * HMAC in Sprint B4). `===` on a secret leaks its prefix through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
