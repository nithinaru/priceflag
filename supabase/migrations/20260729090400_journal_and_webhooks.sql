-- Priceflag — the price journal and webhook dedupe.

-- ---------------------------------------------------------------------------
-- journal_entries  — Shopify keeps no price audit trail; this is it (R18)
-- ---------------------------------------------------------------------------
-- Append-only. Never UPDATE, never DELETE. Two jobs:
--   1. the merchant-facing history of every price change, including ones made
--      by hand in the Shopify admin
--   2. the recovery path — PILOT_RUNBOOK.md restores prices from this table
--      with plain SQL when everything else is broken
create table public.journal_entries (
  id                       uuid primary key default gen_random_uuid(),
  shop_id                  uuid not null references public.shops(id) on delete cascade,
  variant_gid              text not null check (variant_gid like 'gid://shopify/ProductVariant/%'),
  product_gid              text not null,
  title                    text not null default '',
  sku                      text,

  rollout_id               uuid references public.rollouts(id) on delete set null,
  stage_index              integer,

  source                   text not null check (source in ('rollout', 'rollback', 'external',
                                                            'kill_switch', 'manual', 'seed')),
  actor                    text not null check (actor in ('priceflag', 'merchant',
                                                           'shopify_admin', 'system')),
  reason                   text,
  status                   text not null default 'applied'
                             check (status in ('applied', 'failed', 'skipped_noop')),

  before_price_cents       integer not null check (before_price_cents >= 0),
  after_price_cents        integer not null check (after_price_cents >= 0),
  before_compare_at_cents  integer check (before_compare_at_cents >= 0),
  after_compare_at_cents   integer check (after_compare_at_cents >= 0),
  currency                 text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),

  -- Compare-before-write idempotency (R12). Same key = same intended write, so
  -- a retried stage application cannot double-write or double-journal.
  -- Shape: '<rollout_id>:<stage>:<variant_gid>:<target_cents>' for rollout
  -- writes, 'rollback:<rollout_id>:<variant_gid>:<baseline_cents>' for reverts.
  idempotency_key          text,
  error                    text,
  shopify_user_errors      jsonb,

  applied_at               timestamptz not null default now(),
  created_at               timestamptz not null default now(),

  constraint journal_idempotency_key_unique unique (shop_id, idempotency_key)
);

comment on table public.journal_entries is
  'Append-only price audit trail. before_* values are the manual recovery path; idempotency_key makes price writes safely retryable.';
comment on column public.journal_entries.status is
  'skipped_noop = price already matched the target so nothing was written. Expected, not an error.';

create index journal_shop_applied_idx on public.journal_entries (shop_id, applied_at desc);
create index journal_variant_applied_idx on public.journal_entries (shop_id, variant_gid, applied_at desc);
create index journal_rollout_idx on public.journal_entries (rollout_id) where rollout_id is not null;
create index journal_source_idx on public.journal_entries (shop_id, source);

-- ---------------------------------------------------------------------------
-- webhook_events  — HMAC-verified and deduped (R4, R23)
-- ---------------------------------------------------------------------------
-- Shopify retries webhooks, and retries are not rare. Dedupe on the
-- X-Shopify-Webhook-Id header: at-least-once delivery becomes effectively-once
-- processing. A duplicate orders/create that slipped through would corrupt
-- order_days, which drives auto-rollback.
create table public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  shop_domain  text not null,
  shop_id      uuid references public.shops(id) on delete cascade,
  topic        text not null,
  -- X-Shopify-Webhook-Id. Unique index below is the dedupe.
  webhook_id   text not null,
  api_version  text,
  triggered_at timestamptz,
  received_at  timestamptz not null default now(),

  status       text not null default 'received'
                 check (status in ('received', 'processed', 'failed', 'ignored', 'duplicate')),
  attempts     integer not null default 0,
  error        text,
  processed_at timestamptz,

  -- Retained briefly for replay/debugging. GDPR topics store no payload at all.
  payload      jsonb,

  created_at   timestamptz not null default now(),

  constraint webhook_events_dedupe unique (webhook_id)
);

comment on table public.webhook_events is
  'One row per delivered webhook. UNIQUE(webhook_id) turns Shopify at-least-once delivery into effectively-once processing.';

create index webhook_events_topic_received_idx on public.webhook_events (topic, received_at desc);
create index webhook_events_shop_received_idx on public.webhook_events (shop_domain, received_at desc);
create index webhook_events_unprocessed_idx on public.webhook_events (received_at)
  where status in ('received', 'failed');
