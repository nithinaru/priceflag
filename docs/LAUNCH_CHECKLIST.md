# Launch checklist — open beta (Rasa first)

State of the world on 2026-09-16, evening. Everything under **Blocking** was
verified from outside (`/api/health`, GitHub, the repo), not assumed. Do these
in order; each one is a few minutes except the dev-store run.

The credential-free journey (`npm run test:shopify-journey`: OAuth → sync →
COGS → forecast → draft → confirm → order webhook → external edit pause →
verified rollback → uninstall) passes on this branch, as does every other gate
in `PILOT_RUNBOOK.md` plus the new `test:simulator`. What has **not** been
done is the same journey against a real Shopify development store — nobody has
had a dev store token in this repo, and that is item 6 below.

## Blocking — the app cannot take Rasa until these are done

1. **Apply the eight missing migrations to production Supabase.**
   `/api/health` on `priceflag-app.vercel.app` says
   `reachable, but database migrations are missing`; `dashboard.priceflag.org`
   times out on the same probe. While they are missing: order and refund
   webhooks cannot be recorded, order-day sync cannot commit, `shop/redact`
   cannot be honoured, and `ml-nightly` fails every night
   (`source_backend_unavailable`, red since at least 2026-09-13).
   ```bash
   set -a && . ./.env.local && set +a && for f in supabase/migrations/*.sql; do npm run db:apply -- "$f"; done
   curl -s https://dashboard.priceflag.org/api/health | jq '{ok, adapter}'
   ```
   `adapter.ok` must come back `true`. Full explanation: `PILOT_RUNBOOK.md`
   → "Migrations missing in production".

2. **Fix `SHOPIFY_SCOPES` in Vercel Production.** Health reports the app
   currently asks for
   `read_products,write_products,read_orders,write_orders,write_draft_orders`
   and `shopify_scopes_missing: ["read_all_orders"]`. Two write scopes nothing
   uses, and the one scope forecasts need is absent. Delete the variable (the
   code default is right) or set it to the exact list in `docs/auth-setup.md`,
   redeploy, and confirm `shopify_scopes_missing` is `[]`. `main` now refuses
   to start an install while this is wrong, so Rasa would hit
   `scopes_misconfigured` at the door.

3. **Re-enable the evaluator schedule.** GitHub shows the `evaluator` workflow
   as `disabled_manually`; its last run was 2026-08-04. Until it runs, no
   rollout advances, holds, pauses, or emails — ever.
   ```bash
   gh workflow enable evaluator --repo nithinaru/priceflag
   gh workflow run evaluator.yml --repo nithinaru/priceflag
   ```
   Also point the repo variable `PRICEFLAG_URL` at
   `https://dashboard.priceflag.org` (it is `priceflag-app.vercel.app`, which
   needs a bypass secret the workflow may not have).

4. **Merge PR #7** (this branch). It carries the risk-edge fixes, the merge
   with `main`, the Next.js 15.5.25 security patch (`npm audit` was red on
   `main` with a critical), the lab, and this checklist. `main`'s own gates
   only run on pull requests, so nothing has proved `main` green since the
   last PR.

5. **Set Production env** on `priceflag-app` (Vercel → Settings → Environment
   Variables): `APP_URL=https://dashboard.priceflag.org`,
   `SIGNIN_URL=https://dashboard.priceflag.org/signin` (or unset),
   `AUTH_SESSION_SECRET` (an install lands on
   `/signin?error=session_not_configured` without it),
   `PRICEFLAG_SHOP_ALLOWLIST=<rasa>.myshopify.com` (ask Rasa for the exact
   `.myshopify.com` domain — `wearerasa.com` is confirmed Shopify, but the
   internal domain is not public), `RESEND_FROM="Priceflag <kabir@priceflag.org>"`
   with `priceflag.org` verified in Resend. Then run
   `curl -s $APP_URL/api/health | jq` and `docs/auth-setup.md` → "Verifying a
   deployment" in a browser.

6. **Run the development-store journey once, for real.** Follow
   `docs/SHOPIFY_DEVELOPMENT_STORE_RUNBOOK.md` on a Partner dev store with the
   Production build's credentials. It is the only step that proves Shopify's
   side: OAuth redirect allow-list, webhook registration (`uri`, fixed on
   `main` 2026-09-10), a real `productVariantsBulkUpdate`, and a real
   `orders/create` delivery. Record the evidence template. Do not invite Rasa
   before this is green.

7. **Shopify Partner Dashboard.** The app is custom distribution, so:
   `read_all_orders` must be approved (without it history caps at 60 days and
   the callback now fails the install); the allowed redirect URL must be
   `https://dashboard.priceflag.org/api/auth/callback`; the app URL must be the
   dashboard host; and protected-customer-data access for orders must be
   requested. Confirm all four in the dashboard.

## Should do before Rasa sees it

- **Rasa sells subscriptions.** Selling-plan variants are excluded from
  repricing by design (R22). Expect their subscription SKUs to show as "not
  repriceable"; decide now whether that is the message you want on day one.
- **`legal.html` on the marketing site** still describes releasing a price
  "to a growing share of your store's traffic" and "traffic percentages". That
  is A/B testing, which the product promise says you never do. Fix before a
  high-ticket buyer reads both pages.
- **Marketing site deploy is blocked** (`priceflag-website` commit `ae3a8fe`,
  the same-price callout): Vercel rejected the deployment because the commit
  author is not on Nithin's team. Nithin redeploys or adds Kabir to
  `nithin-arus-projects`.
- **Domains** (Vercel → Domains, cannot be done from the repo): move
  `signin.priceflag.org` from `priceflagv1` to `priceflag-app`; add
  `product.priceflag.org` to `priceflag-app`. Table in `PILOT_RUNBOOK.md` →
  "Launch domains".
- **Guardrail defaults on small stores.** The simulator
  (`docs/SIMULATION_RESULTS.md`) shows the default 35%/2-day units guardrail
  false-pausing 20–40% of healthy rollouts on the two *small* stores over five
  seeds, and 0% on medium and large. A pause is not a revert, so it is safe, but
  it is an email a merchant did not need. Options: default `consecutive_days`
  to 3 when the selection's expected units/day are under ~10, or raise the
  low-volume floor for tiny selections. Tune it in the lab and decide.
- **A stage can advance on a breach day.** The evaluator advances when the
  hold is up and the guardrail has not *fired* — including a day where the
  breach condition holds but the streak is 1 of 2. Visible in the lab's
  day-by-day table. Probably should hold one more day. Product call.

## Nice to have

- Vercel CLI is old locally (54 → 59); `npm i -g vercel@latest`.
- The `evaluator` workflow's bypass secret comment says the production domain
  needs none; once `PRICEFLAG_URL` is the dashboard, remove the stale
  `VERCEL_AUTOMATION_BYPASS_SECRET` if it exists.
- `app-ci` and `production-gates` overlap; pick one as the required check on
  `main` and enable branch protection so direct pushes cannot go red silently.

## What was verified tonight (this branch, `fix/rollout-risk-edges`)

- `npm run typecheck`, `smoke` (147), `test:auth` (23+23), `test:merchant-api`
  (39), `test:pricing-safety` (15), `test:ml-ingest`, `test:optimizer` (21),
  `test:webhooks`, `test:deployment-safety` (166), `test:founder-lab` (5),
  `test:simulator` (7), `test:shopify-journey`, integration `--demo` (75),
  `npm audit --audit-level=high` (after the Next.js and sharp bumps),
  `npm run build`.
- Production probes: both health URLs 503 for the reasons in items 1–2;
  Rasa's storefront is Shopify; `evaluator` workflow disabled; `ml-nightly`
  red nightly.
