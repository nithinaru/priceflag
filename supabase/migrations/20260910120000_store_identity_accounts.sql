-- Priceflag — the store becomes the identity.
--
-- Until now there were two ways to be somebody here: a Supabase Auth user who
-- had proved control of an email address (`accounts`, minted by a magic link),
-- and a Shopify store that had installed the app (`shops`). Signing up meant
-- creating the first, then connecting the second, then hoping a ten-minute
-- cookie had stitched them together.
--
-- The magic link is gone (see `app/signin`). The only way in is now the Shopify
-- install itself, which means an account is no longer a person-who-might-have-a
-- -store; it is exactly one store's owner, created at the moment the install
-- completes. Two consequences for this schema:
--
--   1. `accounts.id` can no longer reference `auth.users`. Nothing creates
--      Supabase Auth users any more, so the foreign key would reject every
--      insert. The id is now the `shops.id` uuid of the store that was
--      installed, which makes the account row derivable rather than allocated.
--
--   2. `accounts.email` is the Shopify shop-owner address read from the Admin
--      API at install. It is contact information, never a credential — nothing
--      in the app authenticates against it.
--
-- Existing rows are left in place. A magic-link-era account is now simply an
-- account with no store attached, and it goes away with its owner's store link
-- or not at all; dropping them would lose the `account_shops` history of who
-- connected which store, which support and compliance deletion both read.

-- ---------------------------------------------------------------------------
-- 1. Release accounts from Supabase Auth.
-- ---------------------------------------------------------------------------
alter table public.accounts
  drop constraint if exists accounts_id_fkey;

-- The id must still be a uuid we did not invent twice. It is now the shop row's
-- own id, so uniqueness is inherited from `shops` and the primary key is enough.

comment on table public.accounts is
  'One row per connected store, keyed by shops.id and created when the Shopify '
  'install completes. Holds the shop-owner email for contact only — never a '
  'credential, and never authorisation for shop data.';

comment on column public.accounts.id is
  'The shops.id of the store this account owns. Not a Supabase Auth user id.';

comment on column public.accounts.email is
  'Shop-owner email read from the Shopify Admin API at install. Contact only.';

-- ---------------------------------------------------------------------------
-- 2. Keep the account alive exactly as long as its store.
-- ---------------------------------------------------------------------------
-- Previously the cascade ran from auth.users. With the store as the identity,
-- deleting a shop row (compliance deletion is the case that matters) must take
-- the derived account with it, or a `shop/redact` would leave the owner's email
-- behind in a table nobody thinks to look at.
alter table public.accounts
  add constraint accounts_shop_fk
  foreign key (id) references public.shops (id) on delete cascade
  not valid;

-- `not valid` above, validated separately: pre-existing magic-link accounts have
-- ids that are Supabase Auth uuids and match no shop, so an immediately-enforced
-- constraint would fail the migration on any deployment that has ever had a
-- sign-in. Validation is therefore deliberately NOT run here — new rows are
-- checked, old rows are grandfathered. Run
--   alter table public.accounts validate constraint accounts_shop_fk;
-- once the legacy rows have been cleared.
