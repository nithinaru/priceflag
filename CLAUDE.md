# CLAUDE.md — working notes for agents on Priceflag

This repo is built by **three parallel Claude Code sessions** (lanes A/B/C).
Before doing anything: read `README.md`, then `PRD.md`, then `BUILD_BRIEF.md` —
identify your lane, and obey BUILD_BRIEF §2 (non-collision rules) absolutely.
If any older doc or comment conflicts with `BUILD_BRIEF.md`, the build brief wins.

## Ground rules (all lanes)

- **Positioning is load-bearing**: Priceflag stages price changes by SKU cohort
  and time, NEVER by traffic. Do not add per-visitor price variation in any
  form — it breaks ad feeds, funnel consistency, and trust. "Every visitor sees
  the same price" is a product promise.
- Money is **integer cents** everywhere. Never introduce float dollar math.
- Forecasts show their work: confidence tiers (`fitted|partial|assumption`),
  visible breakeven arithmetic, ranges not point estimates. No merchant-facing
  black boxes, no statistics jargon in UI copy.
- Every price write is journaled and reversible. Rollback correctness is sacred:
  pre-rollout prices captured at creation are the single source of truth.
- `ForecastResult`, the `Rollout` state machine, and everything in `contracts/`
  are stable public shapes. Upgrade internals behind them; changing a contract
  is Lane B's job via the request protocol.
- Demo mode stays first-class: seeded, deterministic (`lib/rng.ts`), no
  `Date.now()`/`Math.random()` in engine logic. `Product.hiddenElasticity` is
  demo-simulator ground truth — it must never reach the client or influence a
  forecast.
- ML lane: no model ships unless it beats the incumbent on the eval harness
  (golden-data recovery + backtests). Band calibration is a safety property —
  it drives auto-rollback.

## Non-collision quick card

Work only inside your lane's owned paths (BUILD_BRIEF §1). `git pull --rebase
origin main` at session start and before every push. Stage surgically (`git add
<owned paths>`, never `-A`). Push at every sprint end with message
`Lane X / Sprint Xn: <summary>`, updating `docs/lane-status/lane-x.md` in the
same push. Cross-lane needs go in your `contracts/requests-lane-x.md`, then
mock and move on.

## Verify your changes

- Lane A: `npm run build`; document new UI states in your lane-status file.
- Lane B: `npm run build` + `npx tsx scripts/smoke.ts` (extend it when you touch
  `lib/`); simulator for evaluator work.
- Lane C: `pytest ml/` — recovery/backtest/coverage gates must pass.

When a Shopify API detail is uncertain (rate limits, payload shapes, scopes),
verify against current shopify.dev docs rather than memory — the Admin API
versions quarterly.

## Context from the founding brainstorm (July 2026)

Competitors: Intelligems (per-visitor price A/B incumbent), Shopify Smart
Pricing (suggestions without measurement; gated native A/B), Shopify Rollouts
(theme/checkout only — no pricing). The wedge nobody covers: predict → staged
rollout → guardrails → auto-rollback. Sleeper features merchants lack entirely:
the price journal (Shopify has no price audit trail) and guardrails written
before the change goes live. Honesty about prediction uncertainty is the brand.
