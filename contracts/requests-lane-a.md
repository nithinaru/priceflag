# Lane A → contract & platform requests

Append-only. Lane A writes, Lane B lands. Newest at the bottom.

---

## REQ-A-001 — Root project scaffold does not exist yet (BLOCKING for `npm run build`)

**Filed:** Sprint A1
**Owner:** Lane B (root configs)
**Status:** open

At Sprint A1 start, `main` contained only `PRD.md`, `BUILD_BRIEF.md`, `README.md`,
`LICENSE`. There is no `package.json`, no `tsconfig.json`, no Next config, no
PostCSS config, and no v0 application code (`lib/`, `app/`, `components/`).
BUILD_BRIEF §4/A1 says "refactor v0's three pages onto the primitives" — there
were no v0 pages to refactor, so Lane A **authored** the three pages directly on
the new primitives instead. See `docs/lane-status/lane-a.md`.

Root configs are Lane B-owned, so Lane A cannot create them. Lane A verified
`npm run build` inside a throwaway harness outside the repo (config below +
a copy of `app/` and `components/`). **`npm run build` cannot be green on `main`
until Lane B lands these four files.** Nothing else in Lane A is blocked.

Requested, verbatim (this is the exact config the A1 code was built and
build-verified against — `create-next-app --ts --tailwind --app` output plus
Tailwind v4 wiring):

`package.json`

```json
{
  "name": "priceflag",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "^15.5.22",
    "react": "^19.2.8",
    "react-dom": "^19.2.8"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.3.3",
    "@types/node": "^22.20.1",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "tailwindcss": "^4.3.3",
    "typescript": "^5.9.3"
  }
}
```

Those are the exact versions Lane A's A1 build was verified green against
(`next build`: 6 routes, 13 static pages, no type errors). Any newer 15.x/19.x
is fine.

`postcss.config.mjs`

```js
const config = { plugins: { "@tailwindcss/postcss": {} } };
export default config;
```

`tsconfig.json` — Lane A's imports depend on the standard `@/*` path alias
pointing at the repo root (`@/components/ui`, `@/app/...`). Please keep it.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.ts`

```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {};
export default nextConfig;
```

Notes that keep this cheap for Lane B:

- **Lane A added zero runtime dependencies and intends to keep it that way.**
  No `clsx`, no `tailwind-merge`, no `cva`, no `lucide-react`, no chart library,
  no `next/font` network fetch. Class merging is a 6-line local helper
  (`components/cn.ts`), icons are inline SVG (`components/ui/icons.tsx`), fonts
  are a system stack. If Lane A ever needs a dependency it will be requested
  here first, never added directly.
- **Tailwind v4 needs no `tailwind.config.js`.** All design tokens live in
  `app/globals.css` (`@theme inline` + light/dark CSS custom properties), which
  is Lane A-owned. Please do not add a `tailwind.config.js` — it would split
  token ownership across lanes.
- If your scaffold differs (different Next patch, `src/` layout, `@/*` mapped to
  `./src/*`), land yours and note it in `docs/lane-status/lane-b.md`; Lane A will
  adapt its imports next sprint rather than fight the scaffold.

## REQ-A-002 — `CLAUDE.md` and `PROMPTS.md` are referenced but absent

**Filed:** Sprint A1
**Owner:** Nithin / Lane B (root files)
**Status:** open — informational, not blocking

`README.md` tells agents to read `CLAUDE.md` (ground rules) and `PROMPTS.md`;
neither is on `main`. Lane A worked from the ground rules restated in
BUILD_BRIEF §2.7 instead: integer cents, no per-visitor pricing, forecasts show
confidence honestly, every price write journaled and reversible. All four are
honored in A1 (money is `Cents` everywhere, formatting is the only place it
becomes a decimal). Flagging in case `CLAUDE.md` carries rules Lane A has not
seen.

## REQ-A-003 — Engine surface Lane A is currently mocking

**Filed:** Sprint A1
**Owner:** Lane B (`lib/**`, `contracts/**`)
**Status:** open — not blocking, mock is local

Lane A needs data to render, so `components/mock/engine.ts` holds a **local,
clearly-labelled, delete-on-arrival mock** of the engine surface: types plus
demo-store fixtures. It is the only file Lane A must delete when `lib/` lands.
Lane A imports it in exactly one place per page, so the swap is mechanical.

The shapes Lane A guessed at, so Lane B can confirm or correct them (Lane A will
follow `contracts/` and `lib/types.ts` once they exist — these are guesses, not
requirements):

| Mock export | What the UI needs from it |
|---|---|
| `Cents = number` | Integer cents everywhere; only `components/format.ts` divides by 100. |
| `Product` | `id`, `title`, `variantTitle?`, `sku`, `priceCents`, `compareAtCents \| null`, `cogsCents \| null`, `cogsSource: "shopify" \| "manual" \| null`, `kind: "standard" \| "subscription" \| "gift_card"`, `units30d`, `inLiveRollout: boolean`. `cogsSource` drives the "where did this cost come from" indicator (R3). `kind` drives the excluded-from-selection badges (R22). |
| `Rollout` | `id`, `name`, `status: "draft" \| "scheduled" \| "live" \| "holding" \| "paused_external" \| "rolled_back" \| "completed"`, `change: {kind:"percent"\|"absolute", value:number}`, `productIds`, `stages: RolloutStage[]`, `currentStageIndex`, `guardrail`, `startedAt`, `endedAt`. |
| `RolloutStage` | `sharePct` (25/50/100), `holdDays`, `status: "completed" \| "active" \| "pending" \| "skipped"`, `startedOn`, `completedOn`, `skuCount`. |
| `Guardrail` | `unitsDropPct: number`, `forDays: number`, `action: "revert_all"`. Rendered as one editable sentence (R10) — please keep it storable as these three fields rather than a free-text string. |
| `RolloutReading` | `date`, `actualUnits`, `expectedUnits`, `expectedLow`, `expectedHigh`, `verdict: "within" \| "below" \| "above"`, `confidence`. Matches `expected_band.schema.json` as described in BUILD_BRIEF §3 plus a precomputed `verdict` — **if the verdict is computed server-side, please expose it**; Lane A would rather render a decision than make one about whether a rollout is healthy. |
| `RolloutEvent` | `at`, `kind`, `message` (plain language, merchant-facing), `detail?`. Lane A renders `message` verbatim, so it must be plain language (R25) — no "guardrail threshold breached". |
| `JournalEntry` | `at`, `productTitle`, `sku`, `fromCents`, `toCents`, `actor: "priceflag" \| "you" \| "external"`, `kind: "rollout" \| "rollback" \| "external" \| "manual"`, `reason`, `rolloutId \| null`. |
| `ConfidenceTier` | `"fitted" \| "partial" \| "assumption"`. Lane A owns the plain-language sentence for each tier; please also send `explanation` per `forecast_result.schema.json` and Lane A will prefer yours when present. |

Two behavioural requests, both for the "what is live right now and how do I undo
it" glance test that Lane A is graded on:

1. **A store-wide "what is live right now" read** — one call that answers: is
   anything live, which rollout, which stage, how many SKUs currently hold a
   Priceflag price, is it healthy. Lane A's overview page is built around this.
2. **Rollback and kill switch as callable server actions** returning
   `{ok, affectedSkus, message}`. A1 wires the confirm dialog and the toast
   against a mocked no-op; the real ones just need to be awaitable and to report
   what they touched.

## REQ-A-004 — Catalog: cost writes, product type, and a proposal draft

**Filed:** Sprint A2
**Owner:** Lane B (`lib/**`, `app/api/**`, `contracts/**`)
**Status:** open — not blocking, all three are mocked locally

Three things A2 needed that belong to Lane B. All three are behind a local seam,
so landing them is a small, mechanical change on Lane A's side.

**1. A cost-write server action (R3).** Inline cost editing is the feature that
turns "profit unknown" into a real forecast, so it has to be a two-second edit
in the table. Lane A calls a mocked
`saveProductCost(productId, cogsCents: number | null)` in
`components/mock/engine.ts` and already treats it as async and fallible:

```ts
saveProductCost(productId, cogsCents):
  Promise<{ ok: true; cogsCents: number | null }
        | { ok: false; message: string }>
```

Requests on the real one:

- take and return **integer cents**, and accept `null` to mean "unknown again"
  (a merchant must be able to undo a mistyped cost back to unknown, not be stuck
  with a wrong number);
- `message` on failure is shown to the merchant verbatim, so please write it in
  plain language;
- it should set `cogs_source = 'manual'` — Lane A renders "Added by you" vs
  "From Shopify" off that field, and merchants do ask where a number came from;
- a cost **above** the price is allowed (loss leaders are real). Lane A warns but
  saves. Please don't reject it server-side.

**2. `productType` on `Product`.** Added to the mock and used for the catalog's
type filter. Shopify's product type is the obvious source. If `contracts/` names
it differently (`product_type`, or collections instead), say so in
`docs/lane-status/lane-b.md` and Lane A will follow.

**3. A server-side proposal draft, to replace a `sessionStorage` hand-off.** The
catalog can legitimately select 400 SKUs, and 400 ids in a query string is a 6 kB
URL, so A2 parks the selection in `sessionStorage` and `/propose` reads it on
mount (`components/catalog/selection.ts`). That works, and its failure mode is
designed for — a shared `/propose` URL shows an empty state pointing back at the
catalog — but it means the preview screen is client-rendered and a selection
cannot be linked to or resumed on another device.

What would fix it: create a draft row server-side from a set of product ids and
give back a short id, so the URL becomes `/propose/<draftId>`.

```ts
createProposalDraft(productIds: string[]): Promise<{ id: string }>
getProposalDraft(id: string): Promise<{ id: string; productIds: string[] } | null>
```

A3 builds the real propose flow on top of this, so it is worth having by then;
until it exists the seam is one module and one page.

## REQ-A-005 — Two copy fixes in strings Lane A renders verbatim

**Filed:** Sprint A3
**Owner:** Lane B (`lib/engine/**`)
**Status:** open — cosmetic, not blocking

Lane A now renders your sentences verbatim wherever you write one —
`guardrails.rules[].sentence`, `readingSentence`, `healthSentence`,
`confidence_explanation`, `assessment.reason`, event `message` — exactly as the
contracts ask. Two of them read as machine output on screen, and because Lane A
must not rewrite them, they need fixing at source.

1. **`ruleConditionHolds` puts a raw ISO day in a merchant-facing string.** It
   currently produces, and the rollout event log therefore shows:

   > On 2026-07-25, 24 units came in 43% below the 42 units we expected (your limit is 30%).

   Every date Lane A formats itself renders as `25 Jul` in the shop's locale. Could
   the reason use the same shape — `On 25 Jul, …`? Formatting it at the point of
   generation keeps one implementation, and it is the only place an ISO date
   currently reaches a merchant.

2. **`defaultGuardrails()` says "revert everything automatically".** "Revert" is
   the one word in that sentence a non-technical merchant may not use. Lane A's
   builder writes "put every price back automatically" for the guardrails it
   creates, so the two differ only for rollouts created from the default. Worth
   aligning on the plainer wording (R25); Lane A will follow whichever you pick,
   since the stored sentence is the record.

Neither affects behaviour, and Lane A is not working around either — both render
as they arrive.

## REQ-A-006 — Demo mode cannot reach the `fitted` confidence tier

**Filed:** Sprint A3
**Owner:** Lane B (`lib/demo/**`, B6) with Lane C
**Status:** open — not blocking, but it hides a shipped feature

`buildForecast` only produces a `fitted` range when it is handed
`fits: Map<variant_gid, ElasticityFitRow>`. Those live in `elasticity_fits`, which
needs Supabase and Lane C's nightly run, so **demo mode always returns
`confidence: "assumption"` and `fitted: null`.**

That is the correct fallback behaviour (R32) and Lane A leads with breakeven
arithmetic precisely because it is the common case. But it means:

- the fitted range and its drawn band — an A3 deliverable, and CP2's acceptance
  criterion — cannot be seen without a database;
- Lane A had to verify that rendering by temporarily injecting a fit locally
  during QA rather than by opening a page.

Lane A did **not** synthesise fits into the product: `lib/demo/generator.ts`
exposes `truth[]`, and using known elasticities to build a forecast would be
exactly the demo-ground-truth leak CLAUDE.md forbids.

What would fix it: seed `elasticity_fits` for the demo variants from a real Lane C
C2 run against the golden store, and have the demo adapter serve them like any
other fit. Then demo mode exercises `fitted` honestly — real model output, from
the store the demo is about — and CP2 becomes demonstrable without credentials.

---

**Update (A7): REQ-A-006 is resolved.** Lane B's B6 seeded
`lib/demo/elasticity-fits.json` from a real Lane C run and exposed it via
`DemoAdapter.getLatestFits`. The remaining half was Lane A's:
`app/propose/actions.ts` was not asking for fits, so every forecast stayed
`assumption`. Now wired through `getAdapter().getLatestFits(...)`, and the fitted
band has been verified rendering from real model output (`partial` tier,
elasticity −1.82 from `elasticity-poisson-eb-1.0`) rather than by injection.

## REQ-A-007 — A cold-load browser check in CI

**Filed:** Sprint A7
**Owner:** Lane B (`scripts/**`, `.github/workflows/**`)
**Status:** open — not blocking, but it would have saved a session

### Why

Sprint A6 shipped with a documented "hydration bug": the journal's filters and
CSV export appeared dead on a hard load of `/journal`. A7 established that
**nothing was broken**. The diagnosis came from three measurement mistakes —
counting `__reactProps$` keys (React 19 attaches them lazily, on first
interaction), dispatching a synthetic `change` at a controlled `<select>` (React's
value tracker suppresses it), and clicking a native `<select>` (which opens an OS
popup automation cannot drive).

A session went into that. What ends it in minutes is a check that does the only
thing which actually proves hydration: **load each route cold and assert an
interaction changes the DOM.**

The bug class is real even though this instance was not. A genuinely unhydrated
page is one bad `"use client"` boundary or one server/client mismatch away, it
logs no console error, and the page still *looks* right — so nothing in the
current suite would catch it. `npm run build` passing proves the bundle
compiled, not that the browser ran it.

### What would settle it

A script (`scripts/smoke-browser.ts`) that, per route: loads it as a **fresh
top-level navigation** — not a client-side transition, since the bug class only
shows on cold load — performs one real interaction, and asserts the DOM changed.

One assertion per route is enough. These all pass today, so they double as
regression baselines:

| Route | Interaction | Assertion |
|---|---|---|
| `/journal` | type `belt` into `#journal-search` | rows 23 → 1; `Clear filters` appears |
| `/products` | type into `#catalog-search` | row count falls |
| `/products/costs` | type `40.00` into `#cost-0`, press Enter | row shows a profit figure; focus moves to `#cost-1` |
| `/propose` | change the amount field | the forecast card re-renders |
| `/rollouts/[id]` | click `Put prices back` | the confirm dialog opens |

Two notes so the check does not repeat the mistakes it exists to catch:

- **Assert on rendered output, never on React internals.** `__reactProps$`, fibre
  keys and `_reactRoot` are lazily attached or renamed between versions. The only
  sound signal is "I did something and the DOM changed".
- **Drive `<select>` through the framework's own event path** (Playwright's
  `selectOption` does this correctly), not
  `Object.getOwnPropertyDescriptor(...).set` + `dispatchEvent('change')`.

Lane A cannot add this: `scripts/` and `.github/workflows/` are Lane B's, and it
needs a browser dependency Lane A is deliberately free of. CI or a manual
`npm run smoke:browser` before a release is Lane B's call — the value is in it
existing at all.
