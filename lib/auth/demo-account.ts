/**
 * The identity demo mode signs in as.
 *
 * Fixed, and deliberately not random: demo mode is seeded and deterministic
 * everywhere else (`lib/rng.ts`), and an id that changed per visit would make
 * two demo sessions look like two different merchants in the journal.
 *
 * Uuid-shaped because the edge verifier in `middleware.ts` requires it — a
 * non-uuid id signs correctly and is then silently rejected, which is a
 * difficult failure to see from the outside.
 *
 * Lives here rather than beside the route because Next.js only permits a fixed
 * set of exports from a route module.
 */

export const DEMO_ACCOUNT_ID = '00000000-0000-4000-8000-000000000d3a';
export const DEMO_ACCOUNT_EMAIL = 'demo@priceflag.org';
