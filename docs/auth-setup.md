# Sign-in setup

How a merchant gets from the marketing site into Priceflag, and the
configuration that has to exist for it to work.

There is **one** way in: install the Shopify app. Finishing that install *is*
the account — there is no separate sign-up, no password, and no emailed link.

```
merchant types store.myshopify.com
        │
        ▼
GET  /api/auth?shop=…            mints a single-use nonce cookie
        │
        ▼
Shopify's approval screen        one consent, listed below
        │
        ▼
GET  /api/auth/callback          HMAC → nonce → token exchange → shop row
                                 → reads shop owner → creates account
                                 → mints `pf_user` → redirects to `/`
```

The merchant is signed in and looking at their own dashboard. On later visits
the `pf_user` cookie (30 days) admits them directly; when it expires, typing
the store address again is a redirect through Shopify that costs a second,
because Shopify does not re-ask for a grant it has already given.

**None of this authorises a price write.** `pf_user` decides which store's
dashboard to render. Every write independently requires a Shopify session
token, checked in the route handler, every time.

---

## The account *is* the store

`accounts.id` is the `shops.id` uuid of the store that was installed. That is
the whole design: a session cookie resolves to a store by construction, so
there is no window in which somebody is signed in but unattached, and nothing
to reconcile afterwards.

The email on the account is the Shopify shop owner's address, read once at
install from `shop { name email }` (no access scope of its own). It is contact
information — nothing authenticates against it. If that read fails, the account
gets `owner@<store>.myshopify.com` as a placeholder and the install proceeds:
Shopify already considers the app installed at that point, so failing would
leave a store connected to an app its owner cannot reach.

---

## What the merchant approves

One consent screen is the entire permission conversation:

| Scope | Why |
| --- | --- |
| `read_products`, `write_products` | Read the catalog; write the price. |
| `read_orders`, `read_all_orders` | Sales history for forecasts. Without `read_all_orders` the Admin API silently caps history at 60 days. |
| `read_inventory`, `write_inventory` | A staged price change has to move with its inventory state. |
| `read_price_rules`, `write_price_rules` | Priced changes that are expressed as rules rather than variant prices. |

`read_all_orders` needs Shopify's approval on the custom-distribution app
before any store can install. `/api/auth/callback` **fails the install** if the
granted scopes are narrower than the requested list, rather than forecasting on
two months of data while the UI claims 180.

Changing `SHOPIFY_SCOPES` does not re-prompt an already-installed store — each
one has to go through `/signin` again.

---

## The pieces

| Where | What |
| --- | --- |
| `$APP_URL/signin` | The door. One field, one button. Production: `https://dashboard.priceflag.org/signin`. |
| `signin.priceflag.org` | Marketing-site door (the **website** repo). 308s here; it must not try to mint a session. |
| `dashboard.priceflag.org` | This repo, on Vercel. The session origin — cookies exist only here. |
| `GET /api/auth?shop=…` | Starts the install. Reachable by a stranger; that is the point. |
| `GET /api/auth/callback` | Finishes it, and creates the account. |
| `POST /api/auth/demo` | Demo mode only. 404 elsewhere. |
| `POST /auth/sign-out` | Clears `pf_user`. |
| `POST /api/auth/session` | Mints `pf_shop` from a verified Shopify session token — the embedded-admin path, unrelated to sign-up. |

---

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `APP_URL` | yes | `https://dashboard.priceflag.org` in production. Never a `vercel.app` host, never `signin.` or `product.`. The OAuth `redirect_uri` is derived from it and must match what is allow-listed on the Shopify app. |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | yes | From the app's API credentials. |
| `SHOPIFY_SCOPES` | no | Defaults to the list above, and **overrides it silently** when set. Narrowing it below `read_products, write_products, read_orders, read_all_orders` makes `/api/auth` refuse to start an install (`scopes_misconfigured`); check `shopify_scopes_missing` on `/api/health`, because Vercel will not show you the value once it is set. |
| `AUTH_SESSION_SECRET` | yes | Signs `pf_user`. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. If it is missing, an install still completes and stores its token, but lands on `/signin?error=session_not_configured` — set the variable and the next visit works, with no reinstall. |
| `ENCRYPTION_KEY` | yes | Encrypts the offline token at rest. |
| `SIGNIN_URL` | no | Overrides where bounces land. Ignored when it points at a branded or alias host, which would put the sign-in screen on a host that cannot hold the cookie. |
| `PRICEFLAG_MODE` | no | `demo` enables `/api/auth/demo` and the "Open the demo store" button. |

Cookies are **host-only** and live on `APP_URL`'s host. `signin.` and
`product.priceflag.org` 308 to the dashboard before any cookie is read
(`lib/auth/session-host.ts`) — an OAuth callback that landed on an alias host
would arrive without its nonce cookie and fail as `state_mismatch`.

---

## Verifying a deployment

```bash
curl -s "$APP_URL/api/health" | jq '{adapter, shopify_scopes, shopify_scopes_missing}'
```

`shopify_scopes_missing` must be `[]`, and `shopify_scopes` is the list the
merchant will actually be asked to approve — not what the code says, which a
`SHOPIFY_SCOPES` override can silently replace.

Then, in a browser:

1. `$APP_URL/signin` renders one field and one button, with no password dialog.
2. Entering a development store's address lands on Shopify's approval screen
   showing exactly the scopes above.
3. Approving lands on `$APP_URL/` — the dashboard, not the Shopify admin — with
   a `pf_user` cookie set.
4. `POST $APP_URL/auth/sign-out` returns to `/signin?signed_out=1`.

The gate itself is pinned by `npm run test:auth`, which fails if a shared
preview secret, an HTTP Basic prompt, a `?next=` redirect sink, or the
magic-link flow reappears.
