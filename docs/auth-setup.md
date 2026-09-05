# Sign-in setup

How a merchant gets from priceflag.org into the app, and the configuration that
has to exist for it to work.

There are **two** ways in. They are not equal:

1. **Shopify (the product).** The merchant types `store.myshopify.com` on
   `$APP_URL/signin`, approves the app, and lands in Shopify admin. Day to day
   they reopen Priceflag from Apps. Shopify signs a session token;
   `middleware.ts` verifies it. This is the only path that can install, sync,
   or write a price.
2. **Email (the dashboard bookmark).** A magic link proves control of an
   address and mints a `pf_user` cookie. Use it to reopen the dashboard from a
   browser that is not the Shopify admin. If that email has not connected a
   store, the next screen is Connect — then Shopify OAuth records
   `account_shops`. Production screen:
   `https://dashboard.priceflag.org/signin`.
   `signin.priceflag.org` may still exist on the marketing site; it is not the
   product door.

Neither email session is authorisation to write a price. Writes still require
a Shopify session token, checked in the route handler, every time.

### Magic links are bound to one browser

A link authenticates whoever opens it, which on its own is a session-fixation
primitive: request a link to your own address, forward it to somebody else, and
they are now signed into your account, with anything they connect recorded as
yours.

So `/api/auth/magic-link` sets a short-lived HttpOnly nonce cookie and puts the
same nonce in the link; `/auth/callback` requires them to match. A link opened
anywhere other than the browser that asked for it is refused — and refused
*before* it is consumed, so the person who genuinely requested it can still use
it. This is why the sign-in page's `fetch` uses `credentials: 'include'` and why
the CORS response carries `Access-Control-Allow-Credentials`.

---

## The pieces

| Where | What |
| --- | --- |
| `$APP_URL/signin` | In-app sign-in screen in this repo. Production: `https://dashboard.priceflag.org/signin`. |
| `signin.priceflag.org` | Optional marketing-site door (`signin.html` in the **website** repo). Static, no keys. Not the only door. |
| `dashboard.priceflag.org` | This repo, on Vercel. Public product origin. |
| `POST /api/auth/magic-link` | Emails the link. Ungated, CORS-restricted to the sign-in origin. |
| `GET /auth/callback` | Verifies the link, mints `pf_user`, redirects into the app. |
| `POST /auth/sign-out` | Clears `pf_user`. |
| `accounts`, `account_shops` | Who signed in, and which store they connected. |

---

## Manual steps

These cannot be done from the repo. All four are required.

### 1. Supabase — get the publishable key

Supabase → Project Settings → API → **Publishable key** (`sb_publishable_…`, or
the older `anon` JWT). Set it as `SUPABASE_PUBLISHABLE_KEY`.

This key is safe to expose and is deliberately *not* the service-role key: the
magic-link endpoint is reachable by anyone, so it must not hold a key that can
read merchant data.

### 2. Supabase — allow the redirect

Authentication → URL Configuration:

- **Site URL:** `https://dashboard.priceflag.org`
- **Redirect URLs:** add `https://dashboard.priceflag.org/auth/callback**`

The trailing `**` matters. The callback carries a `?next=` parameter when
somebody was heading for a specific page, and an exact-match entry rejects it.

### 3. Supabase — the email template (recommended)

Authentication → Email Templates → **Magic Link**. Replace the link with:

```html
<a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=magiclink">Sign in to Priceflag</a>
```

`{{ .RedirectTo }}`, **not** `{{ .SiteURL }}`. This is the one detail that will
silently break sign-in if you get it wrong. `RedirectTo` is the URL the app
built, and it already carries the `bind` nonce that ties the link to the browser
that requested it (and the `next` path, when there is one). `SiteURL` is a bare
origin and carries neither, so every link built from it is rejected at the
callback as unbound.

This produces the server-side shape, where the callback verifies the token with
no JavaScript and nothing sensitive ever reaches the page.

If you skip this, the stock template still works — `/auth/callback` falls back to
a small bridge page that reads the token out of the URL fragment and posts it
back. It is a real fallback, not a broken state, but the template above is
better: it needs no JavaScript and puts no token in the browser.

### 4. Vercel — domains and env

Add the app domain, then set the env vars below on the app project.

| Project | Domain |
| --- | --- |
| website (`priceflagv1`) | marketing hosts, including `signin.priceflag.org` if still used |
| app (this repo) | `dashboard.priceflag.org` (also `product.priceflag.org` if aliased) |

```
SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
AUTH_SESSION_SECRET=…                       # 32 random bytes, base64url
APP_URL=https://dashboard.priceflag.org
SIGNIN_URL=https://dashboard.priceflag.org/signin
```

`APP_URL` is not optional here. It is the origin the magic link points at, and
if it is unset the code falls back to the Vercel-generated hostname — so the
link in the email would go to `priceflag-app.vercel.app` instead of the
dashboard domain. Production `APP_URL` must be `https://dashboard.priceflag.org`
or `https://product.priceflag.org`, never a `vercel.app` hostname.

Leave `AUTH_COOKIE_DOMAIN` unset. That makes the session cookie host-only, which
is all the app needs; widening it to `.priceflag.org` would send the session to
every subdomain including the static marketing site.

`SIGNIN_URL` should be `$APP_URL/signin` so magic-link failures return to the
in-app sign-in page. Deploy scripts push that default when the env file omits
it. Set `SIGNIN_ORIGINS` only if the sign-in screen is served from more than one
host (for example both the in-app page and `signin.priceflag.org`).

Generate the session secret with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 5. Shopify — update the app URLs

In the Partner dashboard, the app URL and the allowed redirect URL both move to
`dashboard.priceflag.org`. OAuth callbacks fail against a stale host.

---

## Intended production access

The intended production setup is:

- A valid magic-link callback is reachable. Completing a genuine link should not
  401 just because the visitor never used `?access=…`.
- A valid `pf_user` session is enough to enter the app.
- Writes still require a Shopify session token in the route handler. Sign-in
  is not authorisation to change a price.

`APP_ACCESS_SECRET` may still gate preview deployments (Vercel SSO plus the
invite cookie). Do not treat a 401 on `/auth/callback` as expected production
behaviour for a genuine magic link.

---

## Checking it works

```bash
# 1. The endpoint is reachable and CORS is right.
curl -i -X OPTIONS https://dashboard.priceflag.org/api/auth/magic-link \
  -H 'Origin: https://dashboard.priceflag.org' \
  -H 'Access-Control-Request-Method: POST'
# Expect: 204, with access-control-allow-origin echoing the sign-in origin.

# 2. An origin that is not on the list is refused.
curl -i -X OPTIONS https://dashboard.priceflag.org/api/auth/magic-link \
  -H 'Origin: https://example.com'
# Expect: 403.

# 3. A link actually sends.
curl -i -X POST https://dashboard.priceflag.org/api/auth/magic-link \
  -H 'Origin: https://dashboard.priceflag.org' \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
# Expect: 200 {"sent":true}, and an email within a few seconds.

# 4. The app sends a signed-out browser to the in-app sign-in screen.
curl -i https://dashboard.priceflag.org/
# Expect: a redirect to https://dashboard.priceflag.org/signin (or the configured SIGNIN_URL).
```

Then sign in for real and confirm you land on the dashboard, not back at the
sign-in screen — that round trip is the one that exercises every piece at once.
