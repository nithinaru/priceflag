# Lane D — Integration & Adversarial QA

Owner: Lane D. Owned paths: `tests/integration/**`, `docs/QA_REPORT.md`,
`docs/lane-status/lane-d.md`, `contracts/requests-lane-d.md`.

Stance: nothing is verified until Lane D reproduces it. Every claim in a
lane-status file is an assertion, not evidence. Findings live in
[`docs/QA_REPORT.md`](../QA_REPORT.md); this file is the working log.

---

## Environment baseline (measured, not claimed)

Run on 2026-07-30 from a clean worktree (`npm install` from `package-lock.json`,
`uv sync --frozen` in `ml/`).

| Command | Result | Time |
|---|---|---|
| `npm run typecheck` (`tsc` + `tsc -p tsconfig.strict.json`) | **exit 0** | — |
| `npm run build` | **exit 0**, 20 routes, middleware 34.8 kB | — |
| `npx tsx scripts/smoke.ts` | **150 passed, 0 failed** | 11.3 s |
| `cd ml && uv run pytest -q` | **106 passed** | 38.7 s |
| `npx tsx tests/integration/run.ts` (Lane D) | **43 passed, 4 failed** | ~60 s |

The build lanes' own gates are genuinely green. Finding #1 is *not* "the
environment is red" — it is that green gates were measuring a narrower surface
than the claims resting on them.

## What Lane D added

`tests/integration/` — dependency-free, same posture as `scripts/smoke.ts`
(one command, no framework), plus three things the smoke test does not have:

- **`FakeShopify`** (`_harness.ts`) — a programmable Admin API: real price state,
  a complete write log so a test can assert *exactly which variants were
  touched* (R22), and injectable faults: `throttle` (429), `server_error` (500),
  `timeout_before_write`, `timeout_after_write` (the store IS mutated and the
  caller never hears — the crash window), and `user_errors` (HTTP 200 carrying
  `userErrors`).
- **Seeded fuzzing** — `rng(seed)` is the same mulberry32 as
  `lib/demo/generator.ts`, so every failure prints a seed that reproduces it.
- **Both adapters, same suite** — `DemoAdapter` and `SupabaseAdapter` run
  identical assertions, so an adapter-local bug cannot hide.

```bash
npx tsx tests/integration/run.ts          # everything configured
npx tsx tests/integration/run.ts --demo   # DemoAdapter only, no network
```

## Phase 1 — the sacred invariants

| # | Invariant | Verdict |
|---|---|---|
| 1 | Rollback completeness | **HOLDS.** 40 fuzzed rollouts × random SKU counts (1–25), prices that round badly (1, 3, 999, 1667, 12345), percentages that round badly (0.5, 7, 33, 1/3, ±), rollback at every stage, mid-stage interrupts, double rollback, rollback of a *completed* rollout, rollback after a partial stage. Every variant restored to the cent, compare-at included. Journal replay agrees. |
| 2 | Cent-exactness / no float drift | **HOLDS.** 40 000 randomised round trips through Shopify's decimal strings are byte-identical; `applyPercent`/`applyAbsolute`/`applyRounding` always return safe non-negative integers. Rollback reads the *captured* baseline, never an inverse percentage — the property that makes 7%-of-1667 safe. |
| 3 | No write outside the selection (R22) | **HOLDS.** Proven against the write log, not the plan: bystander variants present in the store but absent from the rollout are never written, across stage advance, rollback and kill switch. Gift cards, subscription products and non-`ACTIVE` products are excluded at *write* time and recorded with a reason. |
| 4 | No per-visitor pricing | **HOLDS BY CONSTRUCTION.** The pricing surface (`lib/engine`, `lib/pricing`, `lib/evaluator`, `lib/adapters`, `money.ts`, `types.ts`, `contracts.ts`) contains no identifier for visitor, session, cookie, user-agent, IP or traffic split. `assignCohorts` takes `(rolloutId, variantGids, stages)` — no request, no user, no clock — and is stable across calls and input order. |
| 5 | Idempotency | **HOLDS.** Re-applying a stage writes nothing and journals nothing extra; a rollback repeated three times collapses to one row per variant; the crash window (Shopify applied it, the database never heard) converges on the next reconcile without double-writing. |
| 6 | Concurrency | **MOSTLY HOLDS.** Two evaluators racing on one rollout: exactly one runs, the other reports `locked` — on both adapters. Rollback-during-advance and kill-switch-during-write both converge to baseline. **One failure: [D-01](../QA_REPORT.md) — chained rollouts.** |
| 7 | Append-only journal | **MOSTLY HOLDS.** `UPDATE`, `DELETE` and `ON CONFLICT DO UPDATE` are all rejected by the database, not by convention. **One hole: [D-03](../QA_REPORT.md) — `TRUNCATE`.** |

Failing tests are left failing on purpose. A test that fails because the product
is wrong is a finding, not a test to adjust.

## Corrections to the brief's premises

The brief's own starting assumptions did not survive checking:

- **"B4–B7 and A5–A7 never ran."** They did. `git log` shows Lane A through
  Sprint A7 (`2b89d10`, `b1445d9`) and Lane B through Sprint B7 (`0fcf422`), plus
  four later Lane B commits. The real coverage gaps are elsewhere and are listed
  in the report.
- **"The evaluator cron is genuinely absent — it must be."** It is not absent.
  `.github/workflows/evaluator.yml` is on `main`, scheduled hourly, and its runs
  reach production and return HTTP 200. See [D-02](../QA_REPORT.md).
- **PRD requirements run R1–R33**, not R1–R32. R33 (application authentication)
  was added later and is the PRD's own declared pilot launch blocker.

## Housekeeping

Lane D's own integration run created 88 rollouts on the test shop
`lane-d-test.myshopify.com` in the shared Supabase project. Because the
production evaluator iterates `listActiveRollouts()` across **every** shop, test
rollouts left `running` become hourly errors in a real cron job. The suite now
cancels its own active rollouts at the end of the Supabase pass, scoped strictly
to that shop; verified 0 active rollouts remain across all shops.

## Status

- Phase 1 (sacred invariants) — **complete**, suite committed.
- Phase 2 (adversarial passes) — complete; findings in `docs/QA_REPORT.md`.
- Phase 3 (fixes) — only after the report is pushed, P0/P1 `DEFECT`s only.
