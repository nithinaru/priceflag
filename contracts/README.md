# `contracts/` — the law between the lanes

Lane B owns this directory. Lanes A and C treat it as **read-only**. It holds
every cross-lane surface: JSON Schemas for payloads, `db/` schema docs mirroring
`supabase/migrations/`, and `api.md` for the HTTP surface.

If you need a change, land it under the versioning rules below — never edit a
shape's meaning in place.

## Unit conventions — read this once, save yourself a bug

| Convention | Rule | Example |
|---|---|---|
| **Money** | Integer **cents**, never floats, never strings. Field suffix `_cents`. | `1999` = $19.99 |
| **Percent** | Plain number where `12.5` means 12.5% — *not* `0.125`. Suffix `_pct`. | `change_pct: -10` = 10% price cut |
| **Signed deltas** | Negative means down. A price cut is `change_pct: -10`. | `profit_delta_cents: -4200` |
| **Elasticity** | Own sign, normally negative. `-1.6` = 1% price rise → 1.6% fewer units. | `elasticity: -1.6` |
| **Dates** | `day` fields are `YYYY-MM-DD` in the **shop's** timezone (`shops.timezone`). | `"2026-07-29"` |
| **Timestamps** | RFC 3339 UTC with `Z`. Suffix `_at`. | `"2026-07-29T14:03:00Z"` |
| **Shopify ids** | Full GIDs as strings. Suffix `_gid`. | `"gid://shopify/ProductVariant/42"` |
| **`null` vs absent** | Absent = not applicable. `null` = **known unknown** — render an honest empty state, never a zero. | `profit_cents_per_day: null` when COGS is missing |
| **Percentages of expected** | `threshold_pct: 30` means "30% below expected", i.e. `actual < expected * 0.70`. | |

Rounding rule for money: compute in cents with integer math wherever possible;
where a ratio is unavoidable, round **half away from zero** at the last step
(`lib/money.ts::roundCents`). Two lanes rounding differently is a real bug class.

## Versioning

Every schema carries `contract_version` (semver) and each file's `$id` is stable.

- **Patch** — docs/description only.
- **Minor** — new **optional** field, or a new enum member that consumers may
  ignore. Existing fields never change meaning. Consumers must tolerate unknown
  enum members by falling back (`confidence` → treat unknown as `assumption`).
- **Major** — anything else. Announce it before landing, and keep the old
  shape served for one sprint.

`additionalProperties: false` is deliberate: it turns a typo in a producer into a
loud validation failure instead of a silently-missing number in the UI.
`scripts/smoke.ts` validates fixtures against every schema on every run.

## Files

| File | Producer | Consumer | Purpose |
|---|---|---|---|
| `forecast_result.schema.json` | B (`lib/engine/forecast.ts`) | A (forecast card) | Breakeven sentence, scenario table, fitted range, confidence tier |
| `elasticity_fit.schema.json` | C | B (forecast), A (confidence tier) | Per-variant elasticity + honesty metadata |
| `expected_band.schema.json` | C | B (evaluator), A (chart band) | Per variant × day expected units with interval |
| `guardrails.schema.json` | A (builder UI) | B (evaluator) | The abort conditions, stored immutably with the rollout |
| `proposal_request.schema.json` | A (propose flow) | B (`POST /api/rollouts`) | What a proposal submits |
| `sync_progress.schema.json` | B (sync pipeline) | A (onboarding) | Stage, counts, ETA, plain-language message |
| `journal_entry.schema.json` | B (price writer) | A (journal + CSV) | Every price change ever, with before/after |
| `rollout_report.schema.json` | C | A (post-rollout report) | Realized vs predicted + narrative |
| `db/schema.md` | B | A, C | Table-by-table mirror of the migrations |
| `api.md` | B | A | HTTP endpoints, shapes, and which sprint lands each |

## The fallback chain (why no lane can block another)

For any variant, the forecast and the monitoring band resolve in this order:

1. **`fitted`** — a fresh `elasticity_fits` row (Lane C) with
   `confidence: "fitted"`; bands from fresh `expected_bands`.
2. **`partial`** — a fit exists but is thin (wide SE / little price variation),
   or bands exist but are stale.
3. **`assumption`** — no usable model output. Lane B serves transparent bracket
   math (`lib/engine/forecast.ts`) and the evaluator falls back to a seasonal
   bracket band. **This always works**, so Lane A and Lane C are never blocked
   on each other.

Staleness (R32): model output older than `MAX_BAND_AGE_DAYS = 2` for bands or
`MAX_FIT_AGE_DAYS = 30` for fits is demoted one tier, never served as fresh.
Constants live in `lib/contracts.ts` so all three lanes read the same numbers.
