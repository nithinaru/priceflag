# Pilot runbook

What to do when something goes wrong on a real store. Written to be usable at
2am by someone who did not write the code.

**The one thing to remember:** `journal_entries` is append-only and records the
true before-and-after of every price change Priceflag ever made. Whatever else is
broken, that table can restore the store. Everything below is a faster path to the
same answer.

## ⚠️ Deployment targets — do not deploy over the company homepage

> **`priceflagv1` (`prj_gzNZMOkkZTOSIwkQ6o6cwPIOW5bh`) is the COMPANY HOMEPAGE,
> not this app.** It was the app's original Vercel project, later repurposed:
> Git disconnected, an old static deployment promoted to production, and it
> still holds `priceflag.vercel.app`. Do not touch it — not its domains, not
> its deployments, not its Git settings — and never link or deploy this repo
> to it. Any older note pointing at `priceflagv1.vercel.app` as *the app* is
> stale by definition.
>
> **The app is `priceflag-app` (`prj_RU8NlBDoR7t89BNqn5BagOpmpnmm`)**, team
> `team_AqaBD6YaOf9DIJ7NzbytTZTW`, git-linked to `nithinaru/priceflag@main`.
> When linking locally, write the link file directly from the pinned id —
> `vercel link --project <name>` will offer to create a new project when the
> name does not resolve cleanly.

| | |
|---|---|
| **Production app URL** | https://dashboard.priceflag.org |
| **Vercel deployment** | https://priceflag-app.vercel.app (project `priceflag-app`) |

## Product invariants

These are load-bearing product promises, not style preferences. Anything that
violates one is a bug, whoever wrote it.

- **Prices change by SKU cohort and time, NEVER by traffic.** No per-visitor
  price variation in any form — it breaks ad feeds, funnel consistency, and
  trust. "Every visitor sees the same price" is a product promise.
- **Money is integer cents everywhere.** Never introduce float dollar math.
- **Forecasts show their work**: confidence tiers (`fitted|partial|assumption`),
  visible breakeven arithmetic, ranges not point estimates. No merchant-facing
  black boxes, no statistics jargon in UI copy.
- **Every price write is journaled and reversible.** Rollback correctness is
  sacred: pre-rollout prices captured at rollout creation are the single source
  of truth.
- **`ForecastResult`, the `Rollout` state machine, and everything in
  `contracts/` are stable public shapes.** Upgrade internals behind them.
- **Demo mode stays first-class**: seeded, deterministic (`lib/rng.ts`), no
  `Date.now()`/`Math.random()` in engine logic. `Product.hiddenElasticity` is
  demo-simulator ground truth — it must never reach the client or influence a
  forecast.
- **No ML model ships unless it beats the incumbent on the eval harness**
  (golden-data recovery + backtests). Band calibration is a safety property —
  it drives auto-rollback.
- **Beta posture:** automatic rollback is disabled by default — a guardrail
  breach pauses and alerts. Every merchant API request authenticates with a
  Shopify App Bridge session token; no route derives the shop from an
  unauthenticated parameter.

## Before any deploy

All of these must be green before merging or promoting:

```bash
npm ci
npm run typecheck
npm run smoke
npm run test:merchant-api
npm run test:pricing-safety
npm run test:ml-ingest
npm run test:webhooks
npm run test:deployment-safety
npx tsx tests/integration/run.ts --demo
npm run build
npm audit --audit-level=high
cd ml && uv sync --locked && uv run --locked pytest && uv run --locked python nightly.py
```

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
curl --fail-with-body -sS -X POST "$APP_URL/api/kill-switch" \
  -H "Authorization: Bearer $SHOPIFY_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"confirm":true,"reason":"Support request"}'
```

Engages the store-wide kill switch **first** (so nothing can write another price
while this runs), then reverts every rollout that ever put a price live, then
verifies each one against Shopify. Returns
`{ok, affected_skus, message, restored, failed, unverified}`.

`ok: false` means some prices could not be confirmed — go to
[Manual restore](#manual-restore-from-the-journal).

To let Priceflag write prices again (this resumes nothing):

```bash
curl --fail-with-body -sS -X DELETE "$APP_URL/api/kill-switch" \
  -H "Authorization: Bearer $SHOPIFY_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"confirm":true}'
```

Do not release the switch unless the undo response returned `ok: true`, every
unresolved restoration was reviewed, and Shopify was verified at each original
price. A non-2xx release response means price writes remain disabled.

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
non-sensitive: `/api/cron/evaluate`, `/api/ml/ingest`, `/api/ml/export`, `/api/webhooks/*`,
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
export PRICEFLAG_DEMO_ACCESS_CONFIRM="REVOKE_DEMO_ACCESS:$(git rev-parse HEAD)"
bash scripts/vercel-demo-access.sh revoke
```

The running deployment retains its environment snapshot, so removal alone does
not revoke the credential. From a clean checkout of the currently approved
commit, remove `DEMO_PASSWORD` from the ignored `.env.production.local`, run the
acknowledged `scripts/vercel-stage.sh` flow below, verify the exact staged URL,
and promote only that artifact. Do not use `vercel deploy --prod`: it can assign
production traffic from an unverified local tree.

Once the staged artifact is promoted, revocation is immediate and complete: the
cookie a demo login mints holds the **password**, not the access secret, so the
deployment without `DEMO_PASSWORD` invalidates every outstanding reviewer
session on its next request. Had the cookie carried the access secret, those
sessions would have kept working for their full lifetime.

**To rotate instead of revoking**, use the same pinned wrapper; it prompts
without echoing the new password. Existing cookies stop working after the newly
staged artifact is promoted.

```bash
export PRICEFLAG_DEMO_ACCESS_CONFIRM="ROTATE_DEMO_ACCESS:$(git rev-parse HEAD)"
bash scripts/vercel-demo-access.sh rotate
```

Removing only `DEMO_USERNAME` also disables the path (both must be set), but the
wrapper clears both values from the pinned Preview and Production environments.

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
       variant_gid, before_price_cents, before_compare_at_cents,
       applied_at, creation_sequence
  from journal_entries
 where shop_id = '<shop id>'
   and status = 'applied'
 order by variant_gid,
          creation_sequence asc nulls first,
          applied_at asc,
          created_at asc,
          id asc;
```

`creation_sequence` is the durable order for every new journal entry. Legacy
rows remain null and sort first; their timestamps and id are the deterministic
fallback rather than an invented migration-time order.

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

### Hosted Supabase staging gate

Before testing a Preview, configure the protected GitHub Environment
`priceflag-staging` exactly as described in `README.md`, including required
reviewers, deployment-branch restrictions, the staging-only connection URL,
and the matching secret database sentinel. The workflow deliberately does not
accept a Supabase Management API token. From the candidate branch, an owner can
dispatch the approval-gated run without exposing a secret:

```bash
gh workflow run staging-launch-gates.yml \
  --ref codex/prod-integration \
  -f confirm_action=APPLY_STAGING_MIGRATIONS \
  -f confirm_commit="$(git rev-parse HEAD)"
```

The job must finish green. Its Actions summary is the launch evidence for the
hosted migration, real adapter/adversarial, database lint, and Supabase advisor
gates. A skipped job, missing environment approval, failed advisor request, or
any security warning/error or performance error leaves invite access closed.
Download and retain the `supabase-advisor-evidence-<sha>` artifact with the
release record. The workflow hard-refuses the current Production project ID and
will not mutate a database unless its protected staging identity and sentinel
both match.

The external ML worker never receives a PostgreSQL login, Supabase API key, or
service-role key. The `20260804180000`, `20260804193400`, `20260804193500`, and `20260804193600`
migration chain retires the former `priceflag_ml_readonly` identity. It refuses
to continue if that role participates in any membership except PostgreSQL's
platform-created `postgres` administrator edge (which points toward the retired
role and grants the retired identity nothing), commits NOLOGIN,
NOINHERIT, a zero connection limit and a null password in phase one, then drains
already-authenticated sessions and attests the result in a separate transaction.
It also drops the old RLS policies and revokes direct application-schema grants.
The hosted staging gate calls
`priceflag_internal.pf_attest_ml_database_role_retired()` after every migration
run. Any login, unapproved membership, policy, or direct grant keeps merchant invite access
closed. Do not restore that role or create another external database credential;
real reads go through authenticated `POST /api/ml/export`.

An existing database that recorded an older form of migration `20260804180000`
has no trustworthy proof that a member session never used `SET ROLE`. Its first
staging-gate run therefore commits the login lockout and deliberately stops at
`20260804193600` with a restart-required error. In that case, use the Supabase
dashboard's project restart control, wait for Postgres health to recover, then
rerun the same approval-gated workflow for the same commit. The second run must
apply the drain migration and pass the retirement attestation. Never mark the
failed first run green, and never bypass the restart by editing the retirement
state. A membership error is a separate incident: leave the gate red, identify
and drain the member sessions, and have an authorized database administrator
remove the relationship before retrying.

### Exact-artifact Vercel release

Create `.env.preview.local` from `.env.example` using only staging Supabase and
Shopify test-app values. `scripts/vercel-setup.sh` updates only the owner
project's Preview variables, removes legacy static Shopify credentials from that
environment, and creates a protected Preview deployment. It cannot read or
change Production variables and cannot promote or alias the deployment.

After the Preview gates pass, create `.env.production.local` separately and run
`scripts/vercel-stage.sh` from a clean, acknowledged commit. It checks and
updates the Production variables, then creates a Production-environment build with
`--skip-domain`, so the artifact uses production variables but receives no
production traffic. Verify that exact staged URL and its logs. Only an owner may
then promote that same staged URL. Never promote the public Preview directly:
Vercel rebuilds a Preview when converting it to Production, so it would not be
the exact artifact that was tested.

### Real-store ML nightly gate

Before pushing the release candidate, the owner must configure the protected
GitHub Environment `priceflag-ml-release` with a required reviewer, prevent
self-review and administrator bypass, and allow only the
`codex/prod-integration` deployment branch. Store `ML_INGEST_SECRET` and a
Vercel token with deployment-read access as environment secrets. The worker
uses the same rotatable pipeline secret for the narrow export and validated
ingest routes; it never receives Supabase credentials of any kind.

Verify the configuration by name before pushing. The environment response must
show a required reviewer with `prevent_self_review: true`, and the branch-policy
response must contain exactly `codex/prod-integration`. The two ML credential
names must appear under the release Environment and must not appear in the
repository-level secret list:

```bash
gh api repos/nithinaru/priceflag/environments/priceflag-ml-release
gh api repos/nithinaru/priceflag/environments/priceflag-ml-release/deployment-branch-policies
gh secret list --env priceflag-ml-release --repo nithinaru/priceflag
gh secret list --repo nithinaru/priceflag
```

The workflow independently repeats the reviewer/self-review,
administrator-bypass and exact-branch checks against GitHub's API before any
secret-bearing step.

A push to `codex/prod-integration` automatically creates an
`ml-release-gate` run. The reviewer must inspect the exact `GITHUB_SHA` before
approving it. Do not manually dispatch `ml-nightly.yml` against a feature
branch: the production nightly is schedule-only and runs only from `main`.

The release run is evidence only when the verifier passes and the retained
`ml-release-evidence-<sha>-<run>` artifact contains a successful
`real_ingest_evidence.json`. The evidence positively attests the project,
environment, authenticated export authority, visible shops, shops with orders,
acknowledged rows, and read-back model runs for the same commit. It contains no
shop domains, variant identifiers, model-run IDs, order data, connection
details, or credentials. The application target is also attested through
Vercel before the ingest secret is sent. A missing approval, golden-only run,
missing artifact, commit or database mismatch, zero acknowledged rows, failed
write read-back, or failed verifier leaves invite access closed.

After merge, configure `priceflag-ml-production` with the same secret names,
restrict it to `main`, and do not require interactive review so the scheduled
`ml-nightly` job can run. Its first green run must be retained before inviting
merchants. The scheduled job also verifies the live exact-main branch policy
before its secret-bearing step.

### Attested CP4 test-store chain

`scripts/cp4-chain.ts` intentionally performs temporary Shopify price writes,
so it never has a default URL or shop. It loads staging values from the ignored
`.env.preview.local`, verifies the requested URL through Vercel's API as a READY,
non-production deployment belonging to the pinned Priceflag project/team, and
then requires an exact shop acknowledgement:

```bash
export PRICEFLAG_URL='https://<exact-preview-deployment>.vercel.app'
export PRICEFLAG_CP4_SHOP_DOMAIN='<test-store>.myshopify.com'
export PRICEFLAG_CP4_CONFIRM="WRITE_TEST_PRICES:$PRICEFLAG_CP4_SHOP_DOMAIN"
npx --no-install tsx scripts/cp4-chain.ts
```

The script pauses its rollout before cleanup, restores the frozen baselines,
and exits successfully only after Shopify verifies every price and managed
compare-at value. Any failure leaves the rollout paused and requires the manual
restore procedure in this runbook. CP4 proves the ML-to-evaluator chain; it does
not replace the separate merchant-session API and browser end-to-end gate.

| | |
|---|---|
| Production app | https://dashboard.priceflag.org |
| Deployment | https://priceflag-app.vercel.app (project `priceflag-app`) |
| Vercel project | `prj_RU8NlBDoR7t89BNqn5BagOpmpnmm` (team `team_AqaBD6YaOf9DIJ7NzbytTZTW`). **`prj_gzNZMOkkZTOSIwkQ6o6cwPIOW5bh` (`priceflagv1`) / `priceflag.vercel.app` is the company homepage — not this app, do not deploy to it.** |
| Database | Supabase `vnyqevrdvfjsfhdnbfsz` |
| Admin API version | `2026-07` (Shopify versions quarterly; supported 12 months) |
| Evaluator | `/api/cron/evaluate`; `evaluator.yml` is disabled for beta. If enabled after a later safety approval, it needs `Authorization: Bearer $CRON_SECRET` **and** `x-vercel-protection-bypass`. |
| ML access | `POST /api/ml/export` — aggregate allowlist only; legacy DB role is `NOLOGIN` |
