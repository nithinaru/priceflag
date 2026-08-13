# CLAUDE.md — Priceflag product invariants

Operations, deployment targets, and incident procedures live in
`PILOT_RUNBOOK.md` — read it before touching Vercel, Supabase, or anything
that writes a price. Product requirements are in `PRD.md`.

## Product invariants (non-negotiable)

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
  are stable public shapes. Upgrade internals behind them.
- Demo mode stays first-class: seeded, deterministic (`lib/rng.ts`), no
  `Date.now()`/`Math.random()` in engine logic. `Product.hiddenElasticity` is
  demo-simulator ground truth — it must never reach the client or influence a
  forecast.
- ML: no model ships unless it beats the incumbent on the eval harness
  (golden-data recovery + backtests). Band calibration is a safety property —
  it drives auto-rollback.

## Verify your changes

- App/engine: `npm run build` + `npm run smoke`.
- ML: `pytest ml/` — recovery/backtest/coverage gates must pass.
- Full pre-deploy gate: see "Before any deploy" in `PILOT_RUNBOOK.md`.

When a Shopify API detail is uncertain (rate limits, payload shapes, scopes),
verify against current shopify.dev docs rather than memory — the Admin API
versions quarterly.
