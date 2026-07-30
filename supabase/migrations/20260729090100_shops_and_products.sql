-- Priceflag — shops, products (variant-grained), sync runs.

-- ---------------------------------------------------------------------------
-- shops
-- ---------------------------------------------------------------------------
create table public.shops (
  id                     uuid primary key default gen_random_uuid(),
  shop_domain            text not null unique
                           check (shop_domain = lower(shop_domain)),
  name                   text,
  email                  text,

  -- Shopify offline access token, AES-256-GCM at rest (R23). Format is
  -- 'v1.<iv_b64>.<tag_b64>.<ciphertext_b64>' — see lib/crypto.ts. Never logged,
  -- never returned by an API route, null in demo mode.
  access_token_enc       text,
  scopes                 text,
  api_version            text not null default '2026-07',

  currency               text not null default 'USD'
                           check (currency ~ '^[A-Z]{3}$'),
  -- IANA name from Shopify's shop.ianaTimezone. Day boundaries for the
  -- evaluator and for every daily aggregate come from this.
  timezone               text not null default 'UTC',
  plan_name              text,
  mode                   text not null default 'real'
                           check (mode in ('demo', 'real')),

  -- R21 store-level kill switch: when engaged, no writer may touch a price and
  -- every rollout is reverted. Nullable timestamp so we keep the history.
  kill_switch_engaged_at timestamptz,
  kill_switch_reason     text,

  notify_emails          text[] not null default '{}',

  installed_at           timestamptz,
  uninstalled_at         timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.shops is
  'One row per connected Shopify store. access_token_enc is encrypted at rest and must never leave the server.';

create trigger shops_touch before update on public.shops
  for each row execute function public.pf_touch_updated_at();

-- ---------------------------------------------------------------------------
-- products  — ONE ROW PER VARIANT
-- ---------------------------------------------------------------------------
-- Named `products` because that is the frozen contract name, but the grain is
-- the variant: prices, compare-at and unit cost all live on variants in
-- Shopify, and variants are what Priceflag writes. `product_gid` groups them.
create table public.products (
  id                    uuid primary key default gen_random_uuid(),
  shop_id               uuid not null references public.shops(id) on delete cascade,

  product_gid           text not null check (product_gid like 'gid://shopify/Product/%'),
  variant_gid           text not null check (variant_gid like 'gid://shopify/ProductVariant/%'),
  inventory_item_gid    text,

  title                 text not null default '',
  variant_title         text,
  sku                   text,
  vendor                text,
  product_type          text,
  tags                  text[] not null default '{}',
  image_url             text,
  status                text not null default 'ACTIVE'
                          check (status in ('ACTIVE', 'ARCHIVED', 'DRAFT')),

  price_cents           integer not null check (price_cents >= 0),
  compare_at_cents      integer check (compare_at_cents >= 0),
  currency              text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),

  -- Cost of goods. From inventoryItem.unitCost where Shopify has it, else the
  -- merchant types it in (R3). null means genuinely unknown: show "profit
  -- unknown — add cost", never a fabricated profit.
  cogs_cents            integer check (cogs_cents >= 0),
  cogs_source           text not null default 'none'
                          check (cogs_source in ('shopify', 'manual', 'none')),
  cogs_updated_at       timestamptz,

  -- v1 exclusions (R22). Gift cards and anything sold on a subscription
  -- contract are never touched by a rollout.
  is_gift_card          boolean not null default false,
  requires_selling_plan boolean not null default false,
  has_selling_plan      boolean not null default false,

  inventory_quantity    integer,
  available_for_sale    boolean not null default true,

  first_synced_at       timestamptz not null default now(),
  last_synced_at        timestamptz not null default now(),
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint products_shop_variant_key unique (shop_id, variant_gid),
  -- A cost above the price is legal (loss leader) but a negative one is not.
  constraint products_cogs_source_consistent
    check ((cogs_cents is null) = (cogs_source = 'none'))
);

comment on table public.products is
  'One row per Shopify VARIANT (the frozen contract name is `products`). Unique on (shop_id, variant_gid).';
comment on column public.products.cogs_source is
  'shopify = imported from inventoryItem.unitCost, manual = merchant entered, none = unknown (cogs_cents must be null).';

create index products_shop_status_idx on public.products (shop_id, status);
create index products_shop_product_idx on public.products (shop_id, product_gid);
create index products_shop_sku_idx on public.products (shop_id, sku);
create index products_eligible_idx on public.products (shop_id)
  where deleted_at is null
    and status = 'ACTIVE'
    and not is_gift_card
    and not requires_selling_plan
    and not has_selling_plan;

create trigger products_touch before update on public.products
  for each row execute function public.pf_touch_updated_at();

-- ---------------------------------------------------------------------------
-- sync_runs  — backs contracts/sync_progress.schema.json
-- ---------------------------------------------------------------------------
create table public.sync_runs (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  kind             text not null default 'full'
                     check (kind in ('full', 'catalog', 'history', 'baseline')),
  stage            text not null default 'queued'
                     check (stage in ('queued', 'catalog', 'history', 'aggregating', 'done', 'error')),
  message          text not null default 'Getting ready…',

  products_total   integer,
  products_synced  integer not null default 0,
  days_target      integer not null default 180,
  days_synced      integer not null default 0,
  orders_processed integer not null default 0,

  -- Two separate readiness moments: the catalog is usable minutes before 180
  -- days of history finishes, and onboarding says so (R24).
  catalog_ready_at timestamptz,
  history_ready_at timestamptz,

  eta_seconds      integer,
  error_code       text,
  error_message    text,
  error_retryable  boolean,

  -- Shopify pagination cursors, so a resumed sync does not start over.
  cursor           jsonb not null default '{}'::jsonb,

  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.sync_runs is
  'Progress of one sync. The newest row per shop is what GET /api/sync/status serves.';

create index sync_runs_shop_started_idx on public.sync_runs (shop_id, started_at desc);

create trigger sync_runs_touch before update on public.sync_runs
  for each row execute function public.pf_touch_updated_at();
