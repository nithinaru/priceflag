# Database schema

Mirror of `supabase/migrations/`. The migrations are the source of truth; this
document explains the *why* and is the reference Lanes A and C read.

Apply with:

```bash
npx supabase db push
```

Conventions, all of them load-bearing:

- **Money is `integer` cents.** A single price fits in `int4`; anything that can
  exceed ~$21M (revenue aggregates) is `int8`. No `numeric`, no `float`, ever.
- **Percentages** are `numeric` where `12.5` means 12.5%.
- **`day` columns** are calendar dates in the shop's timezone (`shops.timezone`),
  never UTC. Use `pf_shop_day(ts, tz)` to derive one from a timestamp.
- **`*_at` columns** are `timestamptz`.
- **`*_gid` columns** hold full Shopify global ids as text.
- **`null` means unknown**, not zero. `products.cogs_cents IS NULL` means the
  merchant has not told us the cost, and the UI must say so rather than showing a
  profit of £0.
- **RLS is on for every table with no policies.** Only the service role reads or
  writes, and shop scoping happens in `app/api/**`. See the RLS migration for why,
  and for what Sprint B6 adds for Lane C's read-only role.

## Tables

### `shops`

One row per connected store.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `shop_domain` | text unique | lowercase, e.g. `acme.myshopify.com` |
| `access_token_enc` | text | AES-256-GCM, `v1.<iv>.<tag>.<ct>`. **Never** returned by an API route (R23) |
| `api_version` | text | Admin GraphQL version pinned per shop, default `2026-07` |
| `currency` | text | ISO 4217 |
| `timezone` | text | IANA, from `shop.ianaTimezone`. Every day boundary comes from here |
| `mode` | text | `demo` \| `real` |
| `kill_switch_engaged_at` | timestamptz | R21. Non-null means no writer may touch a price |
| `notify_emails` | text[] | R19 |
| `uninstalled_at` | timestamptz | Uninstall clears the token and stamps this; it does **not** delete the row, so a reinstalling merchant keeps their history |

### `products` — **one row per variant**

Named `products` because that is the frozen contract name, but the grain is the
Shopify *variant*: price, compare-at and unit cost all live on variants, and
variants are what Priceflag writes. `product_gid` groups them.

| Column | Type | Notes |
|---|---|---|
| `variant_gid` | text | unique with `shop_id` — the join key everywhere else |
| `product_gid`, `inventory_item_gid` | text | `inventory_item_gid` is where `unitCost` comes from |
| `price_cents`, `compare_at_cents` | int | compare-at nullable |
| `cogs_cents` | int null | null = unknown (R3) |
| `cogs_source` | text | `shopify` \| `manual` \| `none`. A CHECK keeps it consistent with `cogs_cents` |
| `is_gift_card`, `requires_selling_plan`, `has_selling_plan` | bool | v1 exclusions (R22) |
| `status` | text | `ACTIVE` \| `ARCHIVED` \| `DRAFT` |
| `deleted_at` | timestamptz | Variants that vanish from a sync are marked, not deleted — the journal still references them |

A variant is repriceable when it is `ACTIVE`, not deleted, not a gift card, not
on a selling plan, and priced above zero. `products_eligible_idx` is the partial
index for that predicate; `lib/types.ts::exclusionReasonFor` is the single
implementation of the rule.

### `order_days` — daily aggregates, no PII

pk `(shop_id, variant_gid, day)`. **No customer identifier of any kind is stored
here or anywhere else** (R23). Not FK-bound to `products`, so an `orders/create`
webhook for a not-yet-synced variant can still land; the sync reconciles.

| Column | Notes |
|---|---|
| `units`, `orders` | `orders` counts distinct orders containing the variant — **not summable across variants** |
| `gross_revenue_cents`, `discount_cents`, `refund_units`, `refund_cents`, `net_revenue_cents` | `net = gross − discounts − refunds` |
| `realized_unit_price_cents` | `net / units`, so it moves with discounts |
| `list_price_cents` | The price on the product page that day, reconstructed from the journal. **This is the elasticity regressor** — not the realized price |
| `had_stockout`, `on_promo` | Controls. A day with no inventory is not a day of weak demand |

### `sync_runs`

Backs `sync_progress.schema.json`. Two separate readiness moments —
`catalog_ready_at` and `history_ready_at` — because the catalog is usable minutes
before 180 days of order history finishes, and onboarding says so (R24).

### `rollouts`

Draft creation uses the server-only `pf_create_rollout_draft(jsonb, jsonb)` RPC.
It inserts the rollout, its frozen `rollout_variants` selection, and the created
event in one
transaction; execution is revoked from `public`, `anon`, and `authenticated` and
granted only to `service_role`.

| Column | Notes |
|---|---|
| `stages` | jsonb `[{index, fraction, hold_days}]`. Cumulative fractions **of the SKU selection, never of traffic**. Immutable after start |
| `current_stage` | `-1` = nothing live yet |
| `guardrails` | jsonb per `guardrails.schema.json`, frozen at proposal time including the sentence the merchant read (R10) |
| `forecast` | jsonb per `forecast_result.schema.json` as of proposal time, so the post-rollout report compares against what was actually promised (R20/R30) |
| `eval_lock_token`, `eval_locked_until` | Evaluator lease. See "Locking" below |
| `ended_reason` | `completed` \| `guardrail_breach` \| `manual_rollback` \| `kill_switch` \| `external_change` \| `cancelled` |

Statuses: `draft → scheduled → running → paused → completed | rolled_back | cancelled`.
`completed`, `rolled_back` and `cancelled` are terminal. The allowed transitions
are enforced in `lib/engine/rollout.ts::canTransition`.

### `rollout_variants` — why a rollback is always correct

The selection, frozen at creation: `baseline_price_cents` and
`baseline_compare_at_cents` are **the single source of truth for rollback** (R12).
Never recompute a baseline from live Shopify data — by the time you need it, the
live price is the one you changed.

`cohort_stage` is the stage index at which the variant flips to the new price
("live from stage k onward"), assigned deterministically from a hash of
`rollout_id:variant_gid`. `compare_at_action` (`keep` / `clear` / `none`) records
the R13 decision once, at creation.

Excluded variants are stored too, with `excluded = true` and an
`exclusion_reason`, so the rollout page can explain why a product the merchant
picked is not moving.

### `rollout_readings`

One row per rollout per day. **`UNIQUE (rollout_id, day)` is what makes the
evaluator idempotent** (R15): a second run on the same day updates the row instead
of double-counting or double-advancing.

`expected_source` is `model` (Lane C's bands) or `bracket` (Lane B's fallback);
`band_stale` and `band_floored` record when output was demoted or widened, so the
UI never presents a floored band as a confident one.

### `rollout_events`

Append-only timeline. `message` is written for a merchant to read (R25), not for a
log grep.

### `journal_entries` — the price audit trail

Shopify keeps none; this is it (R18). **Append-only**: a trigger rejects UPDATE
outright, and DELETE only inside an explicit purge:

`creation_sequence` supplies a durable recovery order when apply and rollback
timestamps tie. It is null only on legacy rows; new writes receive it from a
server-only sequence.

```sql
begin;
set local priceflag.purge = 'on';
delete from shops where shop_domain = 'acme.myshopify.com';  -- cascades
commit;
```

That escape hatch exists for the GDPR `shop/redact` topic. Uninstall does not use
it.

`idempotency_key` is unique per shop and is what makes a retried price write safe
(R12):

- rollout write — `rollout:<rollout_id>:<stage>:<variant_gid>:<target_cents>`
- rollback — `rollback:<rollout_id>:<variant_gid>:<baseline_cents>` (no stage: one
  restore per variant however many times it is requested)
- observed external change — `null` (observing the same price twice at different
  times is legitimately two facts)

`status = 'skipped_noop'` means the price already matched the target so nothing
was written. Compare-before-write makes that common; it is not an error.

### `webhook_events`

`UNIQUE (webhook_id)` on the `X-Shopify-Webhook-Id` header turns Shopify's
at-least-once delivery into effectively-once processing. A duplicate
`orders/create` or `refunds/create` that slipped through would corrupt
`order_days`, which drives live guardrail decisions. Raw order and refund
payloads are never retained.

### `model_runs`, `elasticity_fits`, `expected_bands`, `rollout_reports`

Written by Lane C, read by Lane B's forecast endpoint and evaluator.

- `model_runs` is the registry (R31). A challenger that loses to the incumbent on
  the eval harness is recorded with `status = 'rejected'` and `gate_passed = false`
  and writes no fits (R28). Keeping the failures is part of the honesty story.
- `elasticity_fits` — unique `(shop_id, variant_gid, model_version)`. A refit of
  the same version replaces the row; a new version lands alongside so champions
  can be compared. Lane B reads the freshest by `fitted_at`.
- `expected_bands` — the interval's calibration is a **safety property**: it
  decides auto-rollback (R29). `band_kind = 'counterfactual'` requires a
  `rollout_id` (CHECK). Uniqueness uses a coalesced `rollout_id`, so raw-SQL
  writers need the expression form:

  ```sql
  insert into expected_bands (...) values (...)
  on conflict (shop_id, variant_gid, day, band_kind, model_version,
               (coalesce(rollout_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  do update set expected_units = excluded.expected_units,
                low = excluded.low,
                high = excluded.high,
                generated_at = excluded.generated_at;
  ```

- `rollout_reports` — unique `(rollout_id, window_days, model_version)`.
  `in_range` is the calibration metric from R30.

## Views for Lane C

Stable read surface so `ml/data.py` does not break when a column moves. Treat the
column names as part of `contracts/`.

| View | Grain | Notes |
|---|---|---|
| `ml_product_days` | variant × day | Units, revenue, `list_price_cents` (the regressor), `dow`, stockout/promo flags, COGS, and `excluded_from_pricing` |
| `ml_products` | variant | Current catalog |
| `ml_price_history` | price change | Applied changes only, with `day` in shop time |
| `ml_rollout_windows` | rollout | Treatment periods and affected variants, for counterfactual work (C5) |

All are `security_invoker = on`. Until Sprint B6 grants the read-only role its
SELECT policies, only the service role can read through them.

## Locking

`pf_acquire_rollout_lock(rollout_id, token, ttl_seconds) -> boolean` and
`pf_release_rollout_lock(rollout_id, token) -> boolean`.

Deliberately a **row lease with a TTL**, not `pg_advisory_lock`: Supabase pools
connections, so a session-level lock cannot be held across HTTP calls and a
transaction-level one dies at statement end. The TTL means a crashed evaluator
self-heals; the token means a stale holder cannot release the lease out from under
whoever took over.

## Helper functions

| Function | Purpose |
|---|---|
| `pf_touch_updated_at()` | BEFORE UPDATE trigger maintaining `updated_at` |
| `pf_shop_day(ts, tz)` | Calendar day of a timestamp in a shop's timezone |
| `pf_journal_is_append_only()` | Guards the journal (see above) |
