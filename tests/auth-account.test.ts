/**
 * Account session cookies — `pf_user`.
 *
 * Two implementations verify this cookie and they must never disagree:
 *
 *   - `verifyUserCookie` in `lib/auth/account.ts`, node:crypto, used by route
 *     handlers to answer "who is this".
 *   - `isValidUserCookie` in `middleware.ts`, crypto.subtle, used by the edge
 *     gate to answer "does this request get through at all".
 *
 * `middleware.ts` cannot be imported here — it pulls in `next/server`, which a
 * plain tsx script has no runtime for. So the edge verifier is replicated below,
 * character for character, and the final section asserts the two agree. A
 * divergence there is a security bug, not a style problem: the edge side is the
 * only thing standing between an unauthenticated request and the app.
 *
 * No env var, network or database. The signing secret is passed explicitly
 * through the options bag both functions accept.
 */

import { createHmac, webcrypto } from 'node:crypto';

import {
  USER_COOKIE,
  USER_COOKIE_MAX_AGE_SECONDS,
  signUserCookie,
  userCookieOptions,
  verifyUserCookie,
} from '../lib/auth/account';

let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function test(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  await run();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

/** Fixed test secret — nothing here reads the environment. */
const SECRET = 'auth-account-test-secret-9f3c1a7d5e2b';
const OTHER_SECRET = 'auth-account-test-secret-9f3c1a7d5e2c';
const USER_ID = '2f1e6b4c-9a3d-4c7e-8b21-5d0f7a6c4e19';
const EMAIL = 'merchant@example.com';
const NOW = new Date('2026-01-15T12:00:00.000Z');

function sign(session: { userId: string; email: string }, now: Date = NOW, secret = SECRET): string {
  return signUserCookie(session, { secret, now });
}

function verify(value: string, now: Date = NOW, secret = SECRET) {
  return verifyUserCookie(value, { secret, now });
}

/** Sign an arbitrary payload the way `signUserCookie` does, shape checks bypassed. */
function signRaw(payload: string, secret = SECRET): string {
  const sig = createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
  return `${payload}.${sig}`;
}

function expirySeconds(now: Date = NOW): number {
  return Math.floor(now.getTime() / 1000) + USER_COOKIE_MAX_AGE_SECONDS;
}

/** Replace the character at `index` with a different one drawn from `alphabet`. */
function flipAt(value: string, index: number, alphabet: string): string {
  const current = value[index] as string;
  const next = [...alphabet].find((candidate) => candidate !== current) as string;
  return value.slice(0, index) + next + value.slice(index + 1);
}

// --- Edge-runtime twin of middleware.ts -------------------------------------
// Replicated verbatim from `middleware.ts`. If that file changes, this must too;
// the whole point of the cross-implementation section is that they are the same.

function edgeToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function edgeHmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await webcrypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function edgeSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `isValidUserCookie` from `middleware.ts`, with `Date.now()` and
 * `process.env.AUTH_SESSION_SECRET` lifted into parameters so the test needs
 * neither a fake clock nor an env var. Nothing else is changed.
 */
async function edgeIsValidUserCookie(
  value: string,
  secret: string | undefined,
  now: Date,
): Promise<boolean> {
  if (!secret) return false;

  const parts = value.split('.');
  if (parts.length !== 4) return false;
  const [userId, emailEncoded, expiryRaw, sig] = parts as [string, string, string, string];
  if (!/^\d+$/.test(expiryRaw)) return false;

  const expected = edgeToBase64Url(
    await edgeHmacSha256(secret, `${userId}.${emailEncoded}.${expiryRaw}`),
  );
  if (!edgeSafeEqual(expected, sig)) return false;
  if (Number(expiryRaw) < Math.floor(now.getTime() / 1000)) return false;

  // Shape checks after the signature, mirroring `verifyUserCookie` exactly.
  if (!/^[0-9a-fA-F-]{36}$/.test(userId)) return false;
  const email = edgeDecodeBase64UrlUtf8(emailEncoded);
  if (email === null || !email.includes('@')) return false;
  return edgeToBase64Url(new TextEncoder().encode(email)) === emailEncoded;
}

/** `decodeBase64UrlUtf8` from `middleware.ts`, unchanged. */
function edgeDecodeBase64UrlUtf8(segment: string): string | null {
  try {
    const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** The edge verifier under the test secret and clock — the usual case. */
function edgeVerify(value: string, now: Date = NOW): Promise<boolean> {
  return edgeIsValidUserCookie(value, SECRET, now);
}

async function main(): Promise<void> {
  // --- 1. Round trip --------------------------------------------------------

  await test('a signed cookie verifies back to the same account', () => {
    const session = verify(sign({ userId: USER_ID, email: EMAIL }));
    assert(session !== null, 'a freshly signed cookie did not verify');
    assert(session.userId === USER_ID, `userId round trip lost: ${session.userId}`);
    assert(session.email === EMAIL, `email round trip lost: ${session.email}`);
  });

  await test('the cookie has exactly four dot-separated segments', () => {
    const parts = sign({ userId: USER_ID, email: EMAIL }).split('.');
    assert(parts.length === 4, `expected 4 segments, got ${parts.length}`);
    assert(parts[0] === USER_ID, 'the userId is not the first segment verbatim');
    assert(parts[2] === String(expirySeconds()), 'the expiry segment is not now + max age');
  });

  await test('signing is deterministic for a fixed clock and secret', () => {
    const a = sign({ userId: USER_ID, email: EMAIL });
    const b = sign({ userId: USER_ID, email: EMAIL });
    assert(a === b, 'two signatures over the same input differed');
  });

  await test('the cookie name and options are the first-party dashboard shape', () => {
    assert(USER_COOKIE === 'pf_user', `unexpected cookie name ${USER_COOKIE}`);
    const secure = userCookieOptions(true);
    assert(secure.httpOnly === true, 'the session cookie is readable from JavaScript');
    assert(secure.sameSite === 'lax', `unexpected sameSite ${secure.sameSite}`);
    assert(secure.secure === true, 'https did not produce a Secure cookie');
    assert(secure.path === '/', `unexpected path ${secure.path}`);
    assert(!('domain' in secure) || secure.domain === undefined, 'session cookie must be host-only');
    assert(secure.maxAge === USER_COOKIE_MAX_AGE_SECONDS, 'maxAge does not match the signed expiry');
    assert(userCookieOptions(false).secure === false, 'plain http produced a Secure cookie');
  });

  // --- 2. Tampering ---------------------------------------------------------

  await test('flipping any single character of any segment invalidates the cookie', async () => {
    const cookie = sign({ userId: USER_ID, email: EMAIL });
    const segments = cookie.split('.') as [string, string, string, string];
    // Alphabets chosen so the flipped segment stays *structurally* valid — a
    // hex/dash userId, a base64url email, digits for the expiry, base64url for
    // the signature. Otherwise a cheap format check would reject it before the
    // HMAC ever ran and the test would prove nothing about the signature.
    const alphabets = ['ab', 'ab', '57', 'ab'] as const;

    let checked = 0;
    for (let segment = 0; segment < 4; segment += 1) {
      const original = segments[segment] as string;
      for (let index = 0; index < original.length; index += 1) {
        const mutated = [...segments];
        mutated[segment] = flipAt(original, index, alphabets[segment] as string);
        const value = mutated.join('.');
        if (value === cookie) continue;
        assert(
          verify(value) === null,
          `segment ${segment} char ${index} tampering was accepted by verifyUserCookie`,
        );
        assert(
          (await edgeVerify(value)) === false,
          `segment ${segment} char ${index} tampering was accepted by the edge verifier`,
        );
        checked += 1;
      }
    }
    assert(checked > 100, `expected a broad tampering sweep, only checked ${checked}`);
  });

  await test('swapping the signature between two accounts is rejected', () => {
    const mine = sign({ userId: USER_ID, email: EMAIL }).split('.');
    const theirs = sign({ userId: USER_ID, email: 'attacker@example.com' }).split('.');
    const forged = [mine[0], theirs[1], mine[2], mine[3]].join('.');
    assert(verify(forged) === null, 'a cookie carrying another account email was accepted');
  });

  await test('an unsigned cookie with a plausible shape is rejected', () => {
    const payload = `${USER_ID}.${Buffer.from(EMAIL, 'utf8').toString('base64url')}.${expirySeconds()}`;
    assert(verify(`${payload}.notarealsignature`) === null, 'an invented signature was accepted');
    assert(verify(`${payload}.`) === null, 'an empty signature was accepted');
  });

  // --- 3. Expiry ------------------------------------------------------------

  await test('a cookie signed in the past has expired', () => {
    const signedAt = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000);
    const cookie = sign({ userId: USER_ID, email: EMAIL }, signedAt);
    assert(verify(cookie) === null, 'a 60-day-old cookie still verified');
  });

  await test('the expiry boundary is inclusive on the last valid second', () => {
    const cookie = sign({ userId: USER_ID, email: EMAIL });
    const expiresAt = new Date(expirySeconds() * 1000);
    assert(verify(cookie, expiresAt) !== null, 'the cookie died one second early');
    assert(
      verify(cookie, new Date(expiresAt.getTime() + 1000)) === null,
      'the cookie outlived its expiry',
    );
  });

  await test('an expired cookie is rejected even with an otherwise valid signature', () => {
    const past = expirySeconds(new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000));
    const email = Buffer.from(EMAIL, 'utf8').toString('base64url');
    const cookie = signRaw(`${USER_ID}.${email}.${past}`);
    assert(verify(cookie) === null, 'a correctly signed but expired cookie was accepted');
  });

  // --- 4. Wrong secret ------------------------------------------------------

  await test('a cookie signed with a different secret is rejected', () => {
    const cookie = sign({ userId: USER_ID, email: EMAIL }, NOW, OTHER_SECRET);
    assert(verify(cookie) === null, 'a cookie signed with a foreign secret was accepted');
    assert(verify(cookie, NOW, OTHER_SECRET) !== null, 'the foreign-secret fixture is not self-consistent');
  });

  await test('a one-character secret difference is enough', () => {
    const cookie = sign({ userId: USER_ID, email: EMAIL });
    assert(verify(cookie, NOW, `${SECRET}x`) === null, 'a longer secret verified the cookie');
    assert(verify(cookie, NOW, SECRET.slice(0, -1)) === null, 'a truncated secret verified the cookie');
  });

  // --- 5. Malformed input, none of which may throw ---------------------------

  const emailEncoded = Buffer.from(EMAIL, 'utf8').toString('base64url');

  /**
   * Correctly signed values whose *shape* is wrong. They have to be signed with
   * the real secret, otherwise the signature check rejects them first and the
   * shape branch in `verifyUserCookie` is never reached.
   */
  const signedButMisshapen = [
    { name: 'a non-UUID userId', value: signRaw(`not-a-uuid.${emailEncoded}.${expirySeconds()}`) },
    {
      name: 'a userId of the wrong length',
      value: signRaw(`${USER_ID}0.${emailEncoded}.${expirySeconds()}`),
    },
    {
      name: 'an email segment that is not valid base64url',
      // '!' is outside the base64url alphabet, so this cannot be what we wrote.
      value: signRaw(`${USER_ID}.not!base64url!.${expirySeconds()}`),
    },
    {
      name: 'an email segment that decodes to something with no @',
      value: signRaw(
        `${USER_ID}.${Buffer.from('nobody', 'utf8').toString('base64url')}.${expirySeconds()}`,
      ),
    },
  ] as const;

  const structurallyInvalid = [
    { name: 'the empty string', value: '' },
    { name: 'a lone dot', value: '.' },
    { name: 'three segments', value: `${USER_ID}.${emailEncoded}.${expirySeconds()}` },
    { name: 'five segments', value: `${sign({ userId: USER_ID, email: EMAIL })}.extra` },
    {
      name: 'a non-numeric expiry',
      value: signRaw(`${USER_ID}.${emailEncoded}.tomorrow`),
    },
    {
      name: 'a negative expiry',
      value: signRaw(`${USER_ID}.${emailEncoded}.-1`),
    },
    {
      name: 'a decimal expiry',
      value: signRaw(`${USER_ID}.${emailEncoded}.1.5`),
    },
    { name: 'whitespace', value: '   ' },
    { name: 'a JSON blob', value: JSON.stringify({ userId: USER_ID, email: EMAIL }) },
  ] as const;

  await test('every malformed cookie verifies as null and none of them throw', () => {
    for (const { name, value } of [...structurallyInvalid, ...signedButMisshapen]) {
      let result: unknown;
      let threw: unknown;
      try {
        result = verifyUserCookie(value, { secret: SECRET, now: NOW });
      } catch (cause) {
        threw = cause;
      }
      assert(threw === undefined, `${name} threw instead of returning null: ${String(threw)}`);
      assert(result === null, `${name} was accepted as a session`);
    }
  });

  await test('a missing secret is a signed-out cookie, not an error', () => {
    const cookie = sign({ userId: USER_ID, email: EMAIL });
    let threw: unknown;
    let result: unknown;
    try {
      result = verifyUserCookie(cookie, { secret: '', now: NOW });
    } catch (cause) {
      threw = cause;
    }
    assert(threw === undefined, `an empty secret threw: ${String(threw)}`);
    assert(result === null, 'an empty secret verified a cookie');
  });

  // --- 6. Emails whose characters matter to the format ----------------------

  const awkwardEmails = [
    'a+b@x.com',
    'a.b.c@d.e.f.com',
    `${'long'.repeat(16)}+tag.with.dots@${'sub.'.repeat(8)}example.com`,
    'UPPER.Case+Tag@Example.COM',
    "o'brien+shop@example.co.uk",
    'a@b.co',
  ] as const;

  await test('emails with +, dots and length round trip through the cookie', () => {
    for (const email of awkwardEmails) {
      const cookie = sign({ userId: USER_ID, email });
      const parts = cookie.split('.');
      assert(
        parts.length === 4,
        `${email} produced ${parts.length} segments — the email was not dot-free`,
      );
      const session = verify(cookie);
      assert(session !== null, `${email} did not verify`);
      assert(session.email === email, `${email} came back as ${session.email}`);
      assert(session.userId === USER_ID, `${email} corrupted the userId`);
    }
  });

  await test('the encoded email segment never contains a dot or padding', () => {
    for (const email of awkwardEmails) {
      const segment = sign({ userId: USER_ID, email }).split('.')[1] as string;
      assert(/^[A-Za-z0-9_-]+$/.test(segment), `${email} encoded outside base64url: ${segment}`);
    }
  });

  // --- 7. Cross-implementation agreement (the one that matters) -------------

  await test('crypto.subtle and node:crypto produce byte-identical signatures', async () => {
    const messages = [
      `${USER_ID}.${emailEncoded}.${expirySeconds()}`,
      '',
      'a',
      `${USER_ID}.${Buffer.from('a+b@x.com', 'utf8').toString('base64url')}.0`,
      // Long enough to cross the SHA-256 block boundary in both implementations.
      'x'.repeat(255),
      // Non-ASCII payload: node keys/messages default to utf8, TextEncoder emits
      // utf8. If either side ever changed to latin1 these would part ways.
      'é☃𝄞',
    ];
    // The empty secret is deliberately absent: crypto.subtle refuses a
    // zero-length HMAC key outright. That asymmetry is pinned on its own below.
    const secrets = [SECRET, 'k', 'é☃𝄞-secret', 'y'.repeat(200)];

    for (const secret of secrets) {
      for (const message of messages) {
        const node = createHmac('sha256', secret).update(message, 'utf8').digest('base64url');
        const edge = edgeToBase64Url(await edgeHmacSha256(secret, message));
        assert(
          node === edge,
          `HMAC diverged for secret ${JSON.stringify(secret)} message ${JSON.stringify(message)}:\n` +
            `  node: ${node}\n  edge: ${edge}`,
        );
        assert(!/[+/=]/.test(node), `base64url output carried base64 characters: ${node}`);
      }
    }
  });

  await test('the edge verifier accepts exactly what signUserCookie mints', async () => {
    for (const email of [EMAIL, ...awkwardEmails]) {
      const cookie = sign({ userId: USER_ID, email });
      assert(
        await edgeVerify(cookie),
        `the edge gate rejected a cookie the app just minted for ${email}`,
      );
      assert(verify(cookie) !== null, `verifyUserCookie rejected its own cookie for ${email}`);
    }
  });

  await test('the edge verifier rejects every forgery verifyUserCookie rejects', async () => {
    const forgeries: { name: string; value: string }[] = [
      ...structurallyInvalid.map((entry) => ({ name: entry.name, value: entry.value })),
      { name: 'a cookie signed with a foreign secret', value: sign({ userId: USER_ID, email: EMAIL }, NOW, OTHER_SECRET) },
      { name: 'an invented signature', value: `${USER_ID}.${emailEncoded}.${expirySeconds()}.forged` },
      {
        name: 'an expired cookie',
        value: sign({ userId: USER_ID, email: EMAIL }, new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000)),
      },
    ];

    for (const { name, value } of forgeries) {
      assert(verify(value) === null, `fixture "${name}" was accepted by verifyUserCookie`);
      assert(
        (await edgeVerify(value)) === false,
        `EDGE/NODE DIVERGENCE: the edge gate admitted "${name}", which verifyUserCookie rejects`,
      );
    }
  });

  await test('both implementations agree on the expiry boundary to the second', async () => {
    const cookie = sign({ userId: USER_ID, email: EMAIL });
    const expiresAt = new Date(expirySeconds() * 1000);
    for (const offsetMs of [-1000, -1, 0, 1, 999, 1000, 2000]) {
      const at = new Date(expiresAt.getTime() + offsetMs);
      const node = verify(cookie, at) !== null;
      const edge = await edgeIsValidUserCookie(cookie, SECRET, at);
      assert(node === edge, `expiry boundary diverged at ${offsetMs}ms: node=${node} edge=${edge}`);
    }
  });

  /**
   * `node:crypto` happily keys an HMAC with the empty string; `crypto.subtle`
   * throws `DataError: Zero-length key is not supported`. Middleware's edge
   * verifiers therefore MUST keep their falsy-secret guards — without one, an
   * unset `AUTH_SESSION_SECRET` would not fail closed, it would throw inside
   * middleware and 500 every request in the matcher. Pinned so the guard is
   * never "simplified" away.
   */
  await test('crypto.subtle refuses a zero-length key where node:crypto accepts one', async () => {
    const node = createHmac('sha256', '').update('payload', 'utf8').digest('base64url');
    assert(node.length > 0, 'node:crypto did not produce a digest for an empty key');

    let threw: unknown;
    try {
      await edgeHmacSha256('', 'payload');
    } catch (cause) {
      threw = cause;
    }
    assert(threw !== undefined, 'crypto.subtle accepted a zero-length key — re-check the guards');
    assert(
      (await edgeIsValidUserCookie(sign({ userId: USER_ID, email: EMAIL }), '', NOW)) === false,
      'the falsy-secret guard is missing: the edge verifier reached crypto.subtle and threw',
    );
  });

  await test('both implementations reject when no signing secret is configured', async () => {
    const cookie = sign({ userId: USER_ID, email: EMAIL });
    assert(verifyUserCookie(cookie, { secret: '', now: NOW }) === null, 'node accepted with no secret');
    assert(
      (await edgeIsValidUserCookie(cookie, '', NOW)) === false,
      'the edge gate accepted with no secret',
    );
    assert(
      (await edgeIsValidUserCookie(cookie, undefined, NOW)) === false,
      'the edge gate accepted with an unset secret',
    );
  });

  /**
   * The edge and node verifiers must accept exactly the same set of values.
   *
   * This used to be a pinned divergence: `middleware.ts` checked only the
   * signature and the expiry, so a cookie signed with the real secret but
   * carrying a malformed identity passed the gate and was then treated as
   * signed-out by the route handlers. Not forgeable — it needs the signing
   * secret — but a dead end for anybody who hit it: admitted by middleware,
   * rejected by the handler, bounced back to a sign-in already completed.
   *
   * The shape checks now live on both sides, and this test is what keeps them
   * there.
   */
  await test('the edge gate rejects correctly signed but misshapen cookies', async () => {
    for (const { name, value } of signedButMisshapen) {
      assert(verify(value) === null, `verifyUserCookie accepted ${name}`);
      assert(
        !(await edgeVerify(value)),
        `the edge gate still admits ${name} — it has diverged from verifyUserCookie again`,
      );
    }
  });

  process.stdout.write(`${passed}/${passed} account auth tests passed\n`);
}

main().catch((cause) => {
  process.stderr.write(`FAIL ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
