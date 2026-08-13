-- Priceflag — accounts (Supabase Auth users) and the account → shop link.
--
-- Until now the only identity in this schema was the shop, because the only way
-- in was the Shopify admin. Signing in at signin.priceflag.org introduces a
-- second, weaker identity: a person who has proved control of an email address
-- but has not necessarily connected a store yet.
--
-- These two tables hold that, and nothing else. Authorisation for price reads
-- and writes still comes from a Shopify session token; `account_shops` only
-- answers "which store should I show this person when they arrive without an
-- admin iframe" (see lib/auth/account-shops.ts).

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
-- A mirror of the auth.users rows we care about. Kept separate rather than
-- querying auth.users directly: that schema belongs to Supabase, and joining
-- application tables to it makes every future Supabase migration our problem.
create table public.accounts (
  -- Same uuid as auth.users.id. On delete cascade so that removing somebody
  -- from Supabase Auth cannot leave an orphaned account row behind.
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null
                  check (email = lower(email)),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

comment on table public.accounts is
  'People who have signed in with a magic link. Not authorisation for any shop data.';

-- ---------------------------------------------------------------------------
-- account_shops
-- ---------------------------------------------------------------------------
create table public.account_shops (
  user_id       uuid not null references public.accounts (id) on delete cascade,
  shop_id       uuid not null references public.shops (id) on delete cascade,
  connected_at  timestamptz not null default now(),

  -- One row per pairing; re-installing the same store just refreshes the date.
  primary key (user_id, shop_id)
);

-- The read this table exists for: "most recently connected store for this
-- person", which is a per-user reverse-chronological lookup.
create index account_shops_user_recent_idx
  on public.account_shops (user_id, connected_at desc);

-- The other direction — "who connected this store" — is wanted during support
-- and during a compliance deletion, both of which start from the shop.
create index account_shops_shop_idx on public.account_shops (shop_id);

comment on table public.account_shops is
  'Which stores an account has connected. A convenience lookup, never an authorisation claim.';

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- Same posture as every other table here: RLS on with no policies, so the
-- anon and authenticated roles can reach nothing. All access is server-side
-- through the service role after the app has resolved who is asking.
alter table public.accounts      enable row level security;
alter table public.account_shops enable row level security;

grant select, insert, update, delete on table public.accounts      to service_role;
grant select, insert, update, delete on table public.account_shops to service_role;
