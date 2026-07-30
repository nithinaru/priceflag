# HTTP API

Every route lives in `app/api/**` (Lane B). Shapes below are **frozen contracts**:
Lane A can build and mock against them before the route exists. The "Landed"
column is the truth about what is implemented right now — anything not marked
`✅` will 404 today, so mock it.

Cross-cutting rules:

- Request and response bodies are JSON, `Content-Type: application/json`.
- Money is integer cents; percentages are plain numbers (`12.5` = 12.5%). See
  `contracts/README.md`.
- The shop is resolved server-side from the embedded session token (Sprint B2).
  Until then routes accept `?shop=<domain>` in development only. **No route ever
  takes a shop id from the client as authorisation.**
- Errors always use the shape below. `message` is safe to show a merchant; `code`
  is what the UI branches on.

```json
{
  "error": {
    "code": "no_eligible_variants",
    "message": "Every product you picked is a gift card or subscription product, which Priceflag never reprices.",
    "retryable": false,
    "details": null
  }
}
```

| Status | When |
|---|---|
| 400 | Malformed body — failed schema validation. `details` lists the offending paths |
| 401 | Missing or invalid session token / cron secret |
| 404 | Unknown shop, rollout, or variant |
| 409 | Conflicting state (e.g. starting a rollout that is already running) |
| 422 | Well-formed but impossible (e.g. every selected variant excluded) |
| 429 | Shopify rate limit reached upstream; `retryable: true` |
| 503 | Adapter unreachable |

## Routes

| Method | Path | Purpose | Landed |
|---|---|---|---|
| GET | `/api/health` | Config and reachability | ✅ B1 |
| GET | `/api/auth` | Start Shopify OAuth (redirects) | B2 |
| GET | `/api/auth/callback` | OAuth callback; stores the encrypted token | B2 |
| POST | `/api/webhooks/[topic]` | HMAC-verified, deduped webhook sink | B4 |
| GET | `/api/live` | Store-wide "what is live right now?" (REQ-A-003) | B4 |
| GET | `/api/shop` | Shop settings, kill-switch state, notification addresses | B2 |
| PATCH | `/api/shop` | Update notification addresses / engage the kill switch | B5 |
| POST | `/api/sync` | Start (or resume) a sync | B3 |
| GET | `/api/sync/status` | `sync_progress.schema.json` | B3 |
| GET | `/api/products` | Paged catalog with search and filters | B3 |
| PATCH | `/api/products/[variantId]/cogs` | Set or clear a unit cost | B3 |
| POST | `/api/forecast` | Dry-run forecast; writes nothing | B3 |
| POST | `/api/rollouts` | Create a draft rollout, freezing baselines and guardrails | B4 |
| GET | `/api/rollouts` | List rollouts | B4 |
| GET | `/api/rollouts/[id]` | Rollout with variants, readings and events | B4 |
| POST | `/api/rollouts/[id]/start` | Go live (or schedule) | B4 |
| POST | `/api/rollouts/[id]/rollback` | One-click manual rollback | B4 |
| POST | `/api/rollouts/[id]/cancel` | Cancel a draft or scheduled rollout | B4 |
| POST | `/api/rollouts/[id]/resume` | Resume after an external-change pause | B4 |
| GET | `/api/journal` | Filterable price journal | B4 |
| GET | `/api/journal.csv` | CSV export | B7 |
| POST | `/api/kill-switch` | Revert everything Priceflag ever changed (R21) | B5 |
| POST | `/api/cron/evaluate` | Evaluator tick. `Authorization: Bearer $CRON_SECRET` | B5 |
| GET | `/api/rollouts/[id]/report` | `rollout_report.schema.json` | B6 |

### `GET /api/health` ✅

```json
{
  "ok": true,
  "mode": "demo",
  "adapter": { "kind": "demo", "ok": true, "detail": "demo store at .priceflag/demo-state.json" },
  "contract_version": "1.0.0",
  "shopify_api_version": "2026-07",
  "configured": {
    "supabase": false, "shopify": false, "encryption_key": false,
    "resend": false, "cron_secret": false
  },
  "time": "2026-07-29T15:00:00.000Z"
}
```

Booleans only — never the values. 503 when the active adapter is unreachable.

### `GET /api/live` — B4

One call that answers the glance test: is anything live, which rollout, which
stage, how many SKUs currently hold a Priceflag price, and is it healthy (R16).
Requested by Lane A as REQ-A-003.

```json
{
  "anything_live": true,
  "kill_switch_engaged": false,
  "skus_holding_priceflag_price": 21,
  "rollouts": [
    {
      "id": "…",
      "name": "Spring margin repair",
      "status": "running",
      "stage_index": 1,
      "stage_count": 3,
      "fraction_live": 0.5,
      "variants_live": 21,
      "variants_total": 42,
      "health": "healthy",
      "health_sentence": "Orders are inside the range we expected.",
      "next_decision_day": "2026-07-31",
      "can": { "rollback": true, "cancel": false, "resume": false }
    }
  ],
  "paused_for_external_change": [],
  "products_missing_cost": 3
}
```

`health` is one of `healthy | watching | breaching | too_early | not_live`, and
`health_sentence` is the merchant-facing wording — render it verbatim (R25).
`watching` is a real state: a rollout with one bad day has not tripped anything,
but calling it "healthy" would be a half-truth. Both come from
`lib/engine/readings.ts`, which is also what the evaluator uses, so the UI and the
machine can never disagree about whether a rollout is healthy.

### `POST /api/forecast` — B3

Body: `proposal_request.schema.json` without `guardrails`.
Response: `forecast_result.schema.json`. Writes nothing, so it is safe to call on
every keystroke (debounced).

422 `no_eligible_variants` when every selected variant is excluded. Individually
excluded variants are **not** an error: they come back in `products[]` with
`excluded: true` and a reason, so the UI can explain them.

### `POST /api/rollouts` — B4

Body: `proposal_request.schema.json`, `guardrails` **required** — no rollout is
created without a conscious guardrail decision.

Creates the rollout as `draft` and, atomically, the frozen selection: baseline
prices, target prices, the compare-at decision, and cohort assignments. The
forecast is stored on the rollout so the post-rollout report can compare against
what was actually promised.

```json
{
  "rollout": { "id": "…", "status": "draft", "stages": [ … ], "current_stage": -1 },
  "variants": { "included": 42, "excluded": 3 },
  "forecast": { "…": "forecast_result.schema.json" }
}
```

### `GET /api/rollouts/[id]` — B4

Everything the rollout page needs in one request — it has to answer "what is live
right now, and how do I undo it?" at a glance (R16).

```json
{
  "rollout": { "…": "status, stages, current_stage, guardrails, ended_reason" },
  "live": { "stage_index": 1, "variants_live": 21, "variants_total": 42, "fraction": 0.5 },
  "variants": [ { "variant_gid": "…", "cohort_stage": 0, "baseline_price_cents": 3200,
                  "target_price_cents": 3520, "applied_at": "…", "excluded": false } ],
  "readings": [ { "day": "2026-07-28", "actual_units": 12, "expected_units": 13.4,
                  "expected_low": 8.1, "expected_high": 18.9, "expected_source": "model",
                  "band_stale": false, "band_floored": false, "breach": false,
                  "breach_streak": 0, "decision": "hold",
                  "verdict": "within",
                  "sentence": "12 units sold against 13.4 expected — inside the range we expected." } ],
  "events": [ { "type": "stage_advanced", "message": "…", "at": "…" } ],
  "health": "healthy",
  "health_sentence": "Orders are inside the range we expected.",
  "can": { "rollback": true, "cancel": false, "resume": false }
}
```

`readings[]` is the actual-vs-expected chart series *and* its uncertainty band.

`verdict` (`within` | `below` | `above`) is computed server-side, as Lane A asked
in REQ-A-003. A day is `below` only when it falls outside the interval, not merely
beneath the point estimate — half of all healthy days sit beneath the point
estimate. The same function backs the evaluator, so the UI cannot show a verdict
the machine did not act on.

`can` exists so the UI does not have to re-derive the state machine.

### `POST /api/rollouts/[id]/rollback` — B4

Body: `{ "reason": "optional plain-language note" }`. Restores every variant this
rollout applied a price to, from the baselines captured at creation, and journals
each write. Idempotent: calling it twice restores once.

```json
{
  "ok": true,
  "affected_skus": 21,
  "message": "Restored the original price on 21 products. Nothing from this rollout is live any more.",
  "rollout": { "status": "rolled_back", "ended_reason": "manual_rollback" },
  "restored": 21,
  "skipped_noop": 0,
  "failed": 0
}
```

`ok` / `affected_skus` / `message` are the shape Lane A asked for in REQ-A-003, so
the confirm dialog and toast can be wired against it directly. `POST /api/kill-switch`
returns the same three fields. On a partial failure `ok` is `false`, `failed` is
non-zero, and `message` names what still needs attention — every attempt is
journalled either way, so `/api/journal` is always the authority on what moved.

### `POST /api/cron/evaluate` — B5

`Authorization: Bearer $CRON_SECRET`, else 401. Runs every 15 minutes and is a
no-op on any (rollout, day) it has already evaluated.

```json
{ "evaluated": 3, "skipped_locked": 0, "advanced": 1, "held": 1, "rolled_back": 1, "errors": [] }
```

### `GET /api/journal` — B4

Query: `variant_gid`, `rollout_id`, `source`, `from`, `to`, `limit`, `offset`.
Returns `{ "items": [journal_entry.schema.json], "total": 1240 }`.
`/api/journal.csv` takes the same query and returns `text/csv`.
