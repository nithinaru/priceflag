# Pilot runbook

What to do when something goes wrong on a real store. Written to be usable at
2am by someone who did not write the code.

**The one thing to remember:** `journal_entries` is append-only and records the
true before-and-after of every price change Priceflag ever made. Whatever else is
broken, that table can restore the store. Everything below is a faster path to the
same answer.

## Merchant API authentication

Every merchant-facing API command below requires a **fresh Shopify App Bridge
session token**. A deployment-access cookie or Vercel bypass only opens the site;
it does not authorize a store. From the embedded app's browser console, obtain a
new short-lived token immediately before running a command:

```js
await shopify.idToken()
```

Copy it only into the current shell (never a file, commit, ticket, or chat):

```bash
read -rs SHOPIFY_SESSION_TOKEN
export SHOPIFY_SESSION_TOKEN
```

If a command returns 401, obtain a new token rather than reusing an expired one.
The examples below assume any separate deployment-protection cookie is already
present in the curl cookie jar.

---

## Fastest possible undo

The merchant wants everything back the way it was, now:

```bash
curl -X POST "$APP_URL/api/kill-switch" \
  -H "Authorization: Bearer $SHOPIFY_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Support request"}'
```

Engages the store-wide kill switch **first** (so nothing can write another price
while this runs), then reverts every rollout that ever put a price live, then
verifies each one against Shopify. Returns
`{ok, affected_skus, message, restored, failed, unverified}`.

`ok: false` means some prices could not be confirmed — go to
[Manual restore](#manual-restore-from-the-journal).

To let Priceflag write prices again (this resumes nothing):

```bash
curl -X DELETE "$APP_URL/api/kill-switch" \
  -H "Authorization: Bearer $SHOPIFY_SESSION_TOKEN"
```

---

## "I get a 401 on every page"

For a page request, that is usually the access gate (`middleware.ts`). Reach the
app once with `?access=<APP_ACCESS_SECRET>` and it sets a 30-day HttpOnly cookie.
For a merchant API request, a 401 after passing that gate means the short-lived
Shopify session token is missing, forged, or expired; refresh it as described
above.

The access gate is an **interim** preview boundary, not tenant authorization. The
merchant APIs independently require Shopify session tokens. Machine endpoints
are exempt because they authenticate themselves, and health is deliberately
non-sensitive: `/api/cron/evaluate`, `/api/ml/ingest`, `/api/webhooks/*`,
`/api/health`.

Operational Shopify webhook callback URLs are capabilities, not public paths:
subscription reconciliation generates a token bound to both the topic and the
normalized shop domain. Never copy one store's callback URL to another store.
The operational set includes `orders/create`, `refunds/create`,
`products/update`, and `app/uninstalled`; refunds must be reconciled so live
revenue and profit guardrails see post-order returns.
Partner-configured privacy callbacks use a topic-bound URL and additionally bind
destructive `shop/redact` requests to the signed `shop_domain` in the payload.
After changing `APP_URL` or the Shopify API secret, reconcile every invited
shop's subscriptions before reopening access.

If `APP_ACCESS_SECRET` is unset in production the gate **fails closed** and
everything returns 401. Set it in Vercel and redeploy.

### Demo credentials (reviewers)

There is a second, separate way in, for people who cannot be handed a secret URL:
`DEMO_USERNAME` / `DEMO_PASSWORD`, typed into the browser's credential dialog
(realm: **"Priceflag demo"**). A successful login mints the same HttpOnly cookie
for **7 days**, so a reviewer authenticates once and then browses normally.

They are deliberately separate from `APP_ACCESS_SECRET` so a review ending does
not break `cp4-chain.ts`, `smoke-browser.ts`, or any `?access=` link.

**To revoke, the moment a review is over:**

```bash
vercel env rm DEMO_PASSWORD production --yes
vercel env rm DEMO_PASSWORD preview --yes
vercel deploy --prod --yes          # a redeploy is required to take effect
```

Revocation is immediate and complete: the cookie a demo login mints holds the
**password**, not the access secret, so clearing `DEMO_PASSWORD` invalidates every
outstanding reviewer session on its next request. Had the cookie carried the
access secret, those sessions would have kept working for their full lifetime —
revocation that does not revoke.

**To rotate instead of revoking**, set a new value and redeploy; existing cookies
stop working for the same reason.

```bash
printf 'new-password' | vercel env add DEMO_PASSWORD production --force
```

Removing only `DEMO_USERNAME` also disables the path (both must be set), but
clear the password — that is what the cookie is checked against.

## Triage

```bash
curl -s "$APP_URL/api/health" | jq
```

| Symptom | Meaning | Action |
|---|---|---|
| `adapter.ok: false`, detail mentions schema | Migrations never applied | `npx supabase db push --db-url "$SUPABASE_DB_URL"` |
| `configured.shopify: false` | No app credentials | Set `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`, redeploy |
| `configured.cron_secret: false` | **The evaluator is not running** | Set `CRON_SECRET`, redeploy. Rollouts are frozen until then — nothing will advance *or* roll back |
| `mode: demo` in production | Serving the simulated store | Set `PRICEFLAG_MODE=real` |

Then the rollout itself:

```bash
curl -s "$APP_URL/api/rollouts/<id>" \
  -H "Authorization: Bearer $SHOPIFY_SESSION_TOKEN" | jq '{status, live, can}'
curl -s "$APP_URL/api/journal?rollout_id=<id>" \
  -H "Authorization: Bearer $SHOPIFY_SESSION_TOKEN" | jq '.items[:5]'
```

---

## "A price is wrong on the storefront"

1. **Find out who changed it.**

   ```bash
   curl -s "$APP_URL/api/journal?variant_gid=gid://shopify/ProductVariant/123" \
     -H "Authorization: Bearer $SHOPIFY_SESSION_TOKEN" | jq '.items[0]'
   ```

   `source: 'external'` means it was changed outside Priceflag — we only observed
   it. `actor: 'priceflag'` means it was us, and `rollout_id` says which rollout.

2. **If a rollout is mid-flight**, roll that one back rather than firing the kill
   switch:

   ```bash
   curl -X POST "$APP_URL/api/rollouts/<id>/rollback" \
     -H "Authorization: Bearer $SHOPIFY_SESSION_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"confirm":true,"reason":"Wrong price reported"}'
   ```

3. **If the journal shows no Priceflag write**, we did not cause it. The merchant
   or another app did. Say so plainly and point at the journal entry.

---

## "The evaluator is not advancing / not rolling back"

In order of likelihood:

1. **The scheduler is not firing.** The evaluator is driven by **GitHub Actions**,
   not Vercel Cron — Deployment Protection 302s an unauthenticated request and
   Vercel Cron does not follow redirects, so it would fail silently. Check
   GitHub → Actions → `evaluator`.

   ```bash
   gh run list --workflow=evaluator.yml --repo nithinaru/priceflag --limit 5
   gh workflow run evaluator.yml --repo nithinaru/priceflag   # force a tick
   ```

   Force one by hand — **both** headers are required. The bypass alone gets a 401,
   the bearer alone gets a 302:

   ```bash
   curl -X POST "$APP_URL/api/cron/evaluate" \
     -H "Authorization: Bearer $CRON_SECRET" \
     -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" | jq
   ```

   A missed run is not urgent: every tick catches up any closed day it has not
   evaluated (up to 14), oldest first.

   **Do not add `crons` back to `vercel.json`.** Besides being swallowed by
   protection, a Hobby account rejects any expression running more than daily and
   the whole deploy fails.

2. **A stale lease.** A crashed evaluator holds its lease for up to 5 minutes and
   then it expires on its own. If a rollout looks stuck much longer:

   ```sql
   select id, name, eval_locked_until from rollouts where eval_locked_until > now();
   -- only if it is genuinely stale:
   update rollouts set eval_lock_token = null, eval_locked_until = null where id = '<id>';
   ```

3. **The current stage is not fully applied.** By design, a rollout will not
   advance while any price in the live stage failed to write. Look for
   `type = 'held'` events and check `rollout_variants.applied_at`:

   ```sql
   select variant_gid, cohort_stage, target_price_cents, applied_at
   from rollout_variants where rollout_id = '<id>' and applied_at is null and not excluded;
   ```

   The next tick retries automatically. If it keeps failing, the journal's
   `status = 'failed'` rows carry Shopify's own error.

4. **Paused for an external change.** `status = 'paused'` with `paused_reason`
   set. Deliberate: someone changed a price we were measuring, so the results no
   longer mean what was predicted.

---

## Manual restore from the journal

The last-resort path, and the reason the journal is append-only. It reconstructs
the price each variant had **before Priceflag first touched it**.

```sql
-- What Priceflag should put back, per variant, for one rollout.
select rv.variant_gid,
       rv.title,
       rv.baseline_price_cents,
       rv.baseline_compare_at_cents,
       rv.applied_at
  from rollout_variants rv
 where rv.rollout_id = '<rollout id>'
   and rv.applied_at is not null
   and not rv.excluded;
```

`baseline_price_cents` is captured at rollout creation and never recomputed —
that is what makes it trustworthy after everything else has gone wrong.

If `rollout_variants` is somehow unavailable, the journal alone is enough:

```sql
-- The earliest price Priceflag ever saw for each variant.
select distinct on (variant_gid)
       variant_gid, before_price_cents, before_compare_at_cents, applied_at
  from journal_entries
 where shop_id = '<shop id>'
   and status = 'applied'
 order by variant_gid, applied_at asc;
```

Apply those with `productVariantsBulkUpdate` in the Shopify admin's GraphiQL app,
one product at a time:

```graphql
mutation {
  productVariantsBulkUpdate(
    productId: "gid://shopify/Product/123"
    variants: [{ id: "gid://shopify/ProductVariant/456", price: "19.99" }]
    allowPartialUpdates: false
  ) { productVariants { id price } userErrors { field message } }
}
```

Then journal what you did, so the trail stays complete:

```sql
insert into journal_entries
  (shop_id, variant_gid, product_gid, title, source, actor, reason, status,
   before_price_cents, after_price_cents, currency, applied_at)
values
  ('<shop id>', '<variant gid>', '<product gid>', '<title>', 'manual', 'system',
   'Manual restore during incident <date>', 'applied', <before>, <after>, 'USD', now());
```

### Deleting a merchant's data (GDPR `shop/redact`)

Deliberately not automated. The journal's delete guard must be lifted explicitly,
in the same transaction:

```sql
begin;
set local priceflag.purge = 'on';
delete from shops where shop_domain = 'acme.myshopify.com';  -- cascades
commit;
```

---

## Things that are working as intended

Worth knowing before "fixing" them:

- **`confidence: "assumption"` with a broad predicted range.** Correct whenever a
  store has sales volume but no reliable price variation to learn from. The
  range uses the documented consumer-goods elasticity default and is labelled
  as an assumption. No range is shown only when usable sales volume is absent.
- **`profit_cents_per_day: null`.** The merchant has not entered a cost. Never a
  zero.
- **`status: "skipped_noop"` in the journal.** The price already matched the
  target. Compare-before-write makes this common; it is not an error.
- **A rollout that will not advance despite good numbers.** Check the hold days —
  stages hold 3–4 days by design.
- **A zero-unit day that does not trip a guardrail.** Below ~3 expected units a
  day, a zero is ordinary noise. The low-volume floor is deliberate.

---

## Escalation facts

| | |
|---|---|
| Deployment | https://priceflag-app.vercel.app (project `priceflag-app`) |
| Vercel project | `prj_RU8NlBDoR7t89BNqn5BagOpmpnmm` (team `team_AqaBD6YaOf9DIJ7NzbytTZTW`). **`prj_gzNZ…` / `priceflag.vercel.app` is the company homepage — not this app, do not deploy to it.** |
| Database | Supabase `vnyqevrdvfjsfhdnbfsz` |
| Admin API version | `2026-07` (Shopify versions quarterly; supported 12 months) |
| Evaluator | `/api/cron/evaluate`, hourly via GitHub Actions `evaluator.yml`; needs `Authorization: Bearer $CRON_SECRET` **and** `x-vercel-protection-bypass` |
| ML role | `priceflag_ml_readonly` — SELECT only, cannot read `shops.access_token_enc` |
