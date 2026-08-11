# Shopify development-store journey runbook

This runbook proves the same safety journey as `npm run test:shopify-journey`
against a Shopify development store. It is evidence collection, not a launch or
production procedure.

## Non-negotiable boundaries

- Use only a Shopify development store created for Priceflag verification.
- Never enter a production shop domain in `PRICEFLAG_SHOP_ALLOWLIST`.
- Never paste credentials, session tokens, signed callback URLs, customer data,
  or Shopify payloads into this document, chat, issues, commits, or evidence.
- Keep `auto_rollback=false`. A guardrail may pause and alert only.
- Do not change Shopify, Supabase, Vercel, or GitHub configuration without the
  repository owner's explicit approval.
- Stop immediately if the shop is not visibly labelled as a development store,
  if the candidate SHA differs, or if any test product/order contains real PII.

## 1. Candidate and environment preflight

Record only redacted facts in a copy of
`docs/shopify-development-store-evidence-template.md`.

1. Record the exact Git commit and deployment identifier.
2. Assign the store a non-identifying evidence alias such as `dev-store-a`.
3. Confirm Shopify Admin identifies it as a development store.
4. Confirm every product, order, email, address, and name is synthetic.
5. Confirm the app requests exactly
   `read_products,write_products,read_orders,read_all_orders`.
6. Confirm the approved callback is `<APP_URL>/api/auth/callback` without
   recording its signed query string.
7. Confirm the runtime has names—not values—for `PRICEFLAG_MODE=real`,
   `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_HANDLE`,
   `SHOPIFY_SCOPES`, `SHOPIFY_API_VERSION`, `APP_URL`, `ENCRYPTION_KEY`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, and
   `PRICEFLAG_SHOP_ALLOWLIST`.
8. Confirm the allowlist contains only the development-store domain.
9. Run the credential-free gate first:

   ```bash
   npm ci
   npm run test:shopify-journey
   ```

Do not continue if either command fails.

## 2. Synthetic store fixture

Create at least eight active, non-gift-card, non-subscription variants under one
or more synthetic products. Use reversible test prices, inventory, and unit
costs. Create synthetic orders spanning multiple days with:

- at least one ordinary sale;
- at least one line discount;
- at least one refund on a later day; and
- no real customer identity or contact details.

Capture counts and cents only. Do not export raw order or webhook payloads.

## 3. Execute the journey

For every step, record UTC time, result, a redacted evidence reference, and the
expected-versus-observed assertion.

1. **Install and OAuth:** open the approved install link, approve the exact
   scopes, and confirm the app lands in Shopify Admin. Record neither the
   authorization code nor callback URL.
2. **Background sync:** observe a durable queued run, catalog readiness, then
   history completion. Verify variant count, imported costs, order count,
   discounts, and refunds.
3. **Manual COGS:** change one synthetic variant's cost and verify it reads back
   with source `manual`.
4. **Forecast:** submit a modest proposal. Record confidence tier, horizon,
   selected SKU count, and the forecast receipt/status—not the full response.
5. **Draft:** create the rollout and verify it is `draft`, stage `-1`, with
   frozen baseline prices and `auto_rollback=false`.
6. **First cohort:** explicitly confirm. Verify only the 25% cohort changed,
   Shopify re-read matched every target, and an identical retry wrote nothing.
7. **Order webhook:** create one synthetic Shopify order. Verify aggregate units,
   revenue, and discount changed once; verify a replay does not double-count.
8. **External edit:** in Shopify Admin, restore one live cohort SKU to its frozen
   baseline. Verify the signed `products/update` delivery creates one `external`
   journal entry, pauses the rollout, and causes no Priceflag price write.
9. **Manual rollback:** explicitly confirm rollback. Verify the merchant-restored
   SKU stays untouched, remaining live cohort SKUs return to frozen baselines,
   every selected SKU is re-read from Shopify, and a retry writes nothing.
10. **Uninstall:** create a harmless future-scheduled rollout, uninstall the app,
    and verify scheduled/running work is paused, drafts are cancelled, the
    uninstall event is journalled, and stored Shopify write authority is null.

## 4. Required safety assertions

- Every rollout retains `guardrails.auto_rollback=false`.
- No write occurs before explicit first-cohort confirmation.
- Only cohort-zero variants change at confirmation.
- Webhook IDs deduplicate order, product, and uninstall retries.
- External merchant state is never overwritten automatically.
- Rollback uses draft-time frozen baselines and verifies live Shopify state.
- Partial or unverifiable rollback remains paused and is never reported as
  successful.
- After uninstall, no rollout is `draft`, `running`, or `scheduled`, and no
  stored access token remains.

## 5. Abort and cleanup

Engage the store-wide kill switch if unexpected Priceflag writes occur. Do not
use automatic rollback. Manually compare every affected development-store SKU
with the frozen baseline before cleanup. Preserve only the redacted evidence
template; remove raw local captures containing headers, signed URLs, tokens, or
payloads. Do not promote, merge, deploy, or reuse the development-store
configuration until the owner reviews the evidence for the exact candidate SHA.
