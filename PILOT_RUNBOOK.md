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

`APP_URL` in production env must be `https://dashboard.priceflag.org`, never a
`vercel.app` project hostname and never `product.priceflag.org` or
`signin.priceflag.org`. The Shopify OAuth round-trip and the `pf_user` cookie
bind to that origin only.

### Launch domains (Vercel dashboard — DNS cannot be changed from this repo)

Do **not** add these hosts to `priceflagv1`, and never deploy this repo there.
`priceflag.org` / `www.priceflag.org` stay on the homepage project.

| Host | Observed now | Required action on Vercel |
|---|---|---|
| `dashboard.priceflag.org` | Bound to `priceflag-app`. Signed-out `/` currently 303s to `https://signin.priceflag.org/` because Production `SIGNIN_URL` points at the marketing door. | On **priceflag-app → Settings → Environment Variables → Production**: set `APP_URL=https://dashboard.priceflag.org` and `SIGNIN_URL=https://dashboard.priceflag.org/signin` (or delete `SIGNIN_URL`). Leave `AUTH_COOKIE_DOMAIN` unset. |
| `signin.priceflag.org` | CNAME to Vercel; **priceflagv1** serves `307 → /signin.html`. That static page must not try to mint a session — the sign-in screen is one field that starts `/api/auth?shop=`. | **priceflagv1 → Settings → Domains** → remove `signin.priceflag.org` only. **priceflag-app → Settings → Domains** → Add `signin.priceflag.org` (accept “move from another project” if offered). After the next *app* deploy, this repo 308s the host to `https://dashboard.priceflag.org/signin` (OAuth callbacks keep `/api/auth/callback`). |
| `product.priceflag.org` | NXDOMAIN — no records. | **priceflag-app → Settings → Domains** → Add `product.priceflag.org`. Vercel will ask for a CNAME to `cname.vercel-dns.com` (or an A/ALIAS it prints). Same 308 to dashboard `/signin`. |
| `priceflag.org` | Homepage on `priceflagv1`. | Leave it. |

Redirects in `next.config.ts` / `middleware.ts` do nothing until the alias hosts resolve to `priceflag-app`. This repo does not deploy itself.

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
npm run test:auth
npm run test:merchant-api
npm run test:pricing-safety
npm run test:ml-ingest
npm run test:optimizer
npm run test:webhooks
npm run test:deployment-safety
npm run test:founder-lab
npm run test:shopify-journey
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

There is no shared access key any more. A page request that redirects to
`/signin` means the browser has neither a Shopify signature nor a valid
`pf_user` cookie — connect the store (one field, one Shopify approval) and the
cookie is minted by `/api/auth/callback`.

A 401 on a **merchant API** request means the short-lived Shopify session token
is missing, forged, or expired; refresh it as described above. That token, not
any cookie, is what authorizes a price write.

If a completed install lands on `/signin?error=session_not_configured`, the
store is connected and the token is stored — the deployment is missing
`AUTH_SESSION_SECRET`. Set it in Vercel and redeploy; the merchant does **not**
need to reinstall.

Machine endpoints are reachable without a session because they authenticate
themselves, and health is deliberately non-sensitive: `/api/cron/evaluate`,
`/api/ml/ingest`, `/api/ml/export`, `/api/webhooks/*`, `/api/health`.

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

### Reviewers and demo access

There is no reviewer password and no `?access=` link. A reviewer either
connects a development store (the same one-approval flow a merchant uses), or
opens a deployment running `PRICEFLAG_MODE=demo`, where `/signin` offers "Open
the demo store" and `POST /api/auth/demo` mints a session against the seeded
simulated catalog. That route 404s on a real deployment.

To close off a demo deployment, unset `PRICEFLAG_MODE=demo` and redeploy: the
route disappears and outstanding demo cookies resolve to a store that no longer
has data.

### Scopes, and what a merchant approves

One consent screen is the entire permission conversation:

```
read_products, write_products,
read_orders, read_all_orders,
read_inventory, write_inventory,
read_price_rules, write_price_rules
```

`read_all_orders` needs Shopify's approval on the custom-distribution app before
a store can install. Without it the Admin API silently caps history at 60 days,
so `/api/auth/callback` **fails the install** rather than forecasting on two
months of data while the UI claims 180.

**Check what this deployment will actually ask for before inviting anyone:**

```bash
curl -s "$APP_URL/api/health" | jq '{shopify_scopes, shopify_scopes_missing}'
```

`shopify_scopes_missing` must be `[]`. If it is not, `/api/auth` refuses to
start an install at all and returns `scopes_misconfigured` — deliberately, at
the door rather than at the callback, because by the callback the merchant has
already approved a consent screen showing the wrong permissions.

This is not hypothetical. On 2026-09-10 production's `SHOPIFY_SCOPES` was
`read_products,write_products,read_orders,write_orders,write_draft_orders` — no
`read_all_orders`, plus two write scopes the app has no code path for. Nothing
surfaced it: OAuth succeeded, `missingScopes` compared the grant against the
same shortened list and found nothing missing, and every forecast would have
been built on 60 days while the UI claimed 180. `SHOPIFY_SCOPES` overrides the
code default and Vercel will not show an environment variable's value once it is
set, so the health field above is the only way to see it from outside.

Changing `SHOPIFY_SCOPES` does not re-prompt an already-installed store. Every
existing store must go through `/signin` again — the callback rejects a token
whose granted scopes are narrower than the list.

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
| `shopify_scopes_missing` non-empty | `SHOPIFY_SCOPES` is narrower than the floor | `/api/auth` refuses installs until it is fixed — see "Scopes" above |

### Migrations missing in production (open, as of 2026-09-16)

Seven migrations in `supabase/migrations/` have never been applied to
`vnyqevrdvfjsfhdnbfsz`, and one more was added on 2026-09-10:

```
20260804043733_atomic_order_webhook_and_compliance
20260804093121_protect_compliance_audit
20260804112000_atomic_refund_webhook
20260804180000_normalize_ml_readonly_privileges
20260804193400_commit_ml_role_login_lockout
20260804193500_verify_ml_role_memberships
20260804193600_drain_and_attest_ml_role
20260910120000_store_identity_accounts
```

None of the objects they create exist yet, so a replay is clean rather than a
reconciliation. What is broken while they are absent:

- **`ml-nightly` fails every night.** `journal_entries.creation_sequence` is
  missing, every journal read orders by it, so the ML export's `price_history`
  surface throws and the run goes red after all its gates pass.
- **`orders/create` and `refunds/create` webhooks cannot be recorded.**
  `pf_ingest_order_webhook` and `pf_ingest_refund_webhook` do not exist.
- **Order-day sync cannot commit** — `pf_commit_order_day_sync_snapshot` does
  not exist.
- **`shop/redact` cannot be honoured.** No `compliance_audit` table and no
  `pf_purge_shop_for_compliance`. This one is a compliance obligation, not a
  degradation.
- **The retired ML database role can still log in** — the lockout and its
  attestation never ran. This is the `smoke` failure that has been dismissed as
  pre-existing.

Apply them in filename order. `supabase db push` cannot reach this project's
direct host from every machine (`LegacyDbConnectError`); the fallback is:

```bash
set -a && . ./.env.local && set +a && for f in supabase/migrations/*.sql; do npm run db:apply -- "$f"; done
```

`db:apply` skips anything already recorded, so the loop is safe to re-run.
Afterwards `/api/health` must report `adapter.ok: true`, and the next nightly
should go green.

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

1. **The scheduler is not firing.** The evaluator is driven by **GitHub Actions**
   (`evaluator.yml`: daily `15 13 * * *` UTC, plus `workflow_dispatch`), not
   Vercel Cron — Deployment Protection 302s an unauthenticated request and
   Vercel Cron does not follow redirects, so it would fail silently. Check
   GitHub → Actions → `evaluator`. Beta still has auto-rollback OFF in the app;
   the schedule only evaluates (advance / pause / alert). Price writes on stage
   advance are intentional once a merchant has confirmed a rollout.

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

### Attested CP4 test-store chain (retired)

The CP4 chain (`scripts/cp4-chain.ts`, deleted 2026-08-13 along with
`scripts/simulate-rollout.ts` as manual-only orphans) proved the
ML-to-evaluator chain by performing attested, temporary Shopify price writes
against a READY non-production deployment, restoring frozen baselines on exit.
If that proof is needed again, recover the script from git history
(`git log --diff-filter=D -- scripts/cp4-chain.ts`); it never replaced the
separate merchant-session API and browser end-to-end gate.

| | |
|---|---|
| Production app | https://dashboard.priceflag.org |
| Deployment | https://priceflag-app.vercel.app (project `priceflag-app`) |
| Vercel project | `prj_RU8NlBDoR7t89BNqn5BagOpmpnmm` (team `team_AqaBD6YaOf9DIJ7NzbytTZTW`). **`prj_gzNZMOkkZTOSIwkQ6o6cwPIOW5bh` (`priceflagv1`) / `priceflag.vercel.app` is the company homepage — not this app, do not deploy to it.** |
| Database | Supabase `vnyqevrdvfjsfhdnbfsz` |
| Admin API version | `2026-07` (Shopify versions quarterly; supported 12 months) |
| Evaluator | `/api/cron/evaluate`. GitHub Actions `evaluator.yml` runs daily at 13:15 UTC plus `workflow_dispatch`. Not Vercel Cron. Needs `Authorization: Bearer $CRON_SECRET`; previews also need `x-vercel-protection-bypass`. Auto-rollback stays OFF in the beta app. |
| ML access | `POST /api/ml/export` — aggregate allowlist only; legacy DB role is `NOLOGIN` |
