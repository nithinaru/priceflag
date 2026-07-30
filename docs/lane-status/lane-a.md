# Lane A — Product UI · status

Owned paths: `app/**` (except `app/api/**`), `components/**`,
`docs/lane-status/lane-a.md`, `contracts/requests-lane-a.md`.

> **Update (after Lane B's B1/B2 landed):** the root scaffold is on `main`, so
> **`npm run build` now runs green in the repo itself** — 10 routes, 14 static
> pages, Lane A's pages and Lane B's API routes together — and `npm run typecheck`
> (shared + Lane B's strict pass) is clean. REQ-A-001 is **resolved**; the
> out-of-repo harness described under Sprint A1 is retired. Lane B kept the `@/*`
> alias, added no `tailwind.config.js`, and removed the four runtime dependencies
> they had pre-added, so Lane A is still dependency-free. `lib/` and `contracts/`
> now exist; `components/mock/engine.ts` is scheduled for deletion as A3 migrates
> the propose flow onto the real `ForecastResult` contract.

| Sprint | State |
|---|---|
| **A1 — Design system foundation** | ✅ done |
| **A2 — Catalog & COGS** | ✅ done |
| A3 — Propose flow v2 | next |
| A4 — Rollout monitoring v2 | not started |
| A5 — Onboarding & sync | not started |
| A6 — Post-rollout report & journal v2 | not started |
| A7 — Polish, a11y, responsive | not started |

---

## Sprint A2 — done

### What landed

**The catalog is now a working tool** — `components/catalog/catalog-table.tsx`,
a client component fed by the server page:

- **Search** on title, variant and SKU, with `useDeferredValue` so typing stays
  responsive at 500 rows.
- **Filters**: product type, cost (has one / no cost yet), price (on a new price /
  unchanged). "Clear filters" appears only when something is filtered.
- **Sort** on every meaningful column, with `aria-sort` on the header and a
  direction that defaults sensibly per column type (names A→Z, numbers
  biggest-first). Products with **no cost sort last in both directions** — they
  are the rows to act on, not to bury at the bottom of a descending sort.
- **Multi-select** with a sticky action bar: count, the blended margin of the
  selection, a warning when part of the selection has no cost, Clear, and one
  primary action. Header checkbox selects all *matching* rows and goes
  indeterminate on a partial selection.
- **Inline cost editing** (`components/catalog/cost-cell.tsx`): click any cost,
  type, Enter to save / Esc to cancel, with saving and failed-to-save states and
  a toast that says what changed. Missing costs render an amber **Add cost**
  button rather than a blank — the state is an invitation, not an absence. Saving
  flips the source indicator to "Added by you".
- Subscriptions and gift cards **stay in the list**, greyed, checkbox disabled,
  reason on the row (R22). A product that silently vanishes from a catalog reads
  as a bug.

**Where the selection goes** — `/propose` (`components/catalog/propose-preview.tsx`).
Deliberately a **calculator, not a wizard**: pick % or an amount, up or down, and
it shows the breakeven sentence plus per-product new price, new profit and margin
before→after. Every number on it is margin arithmetic that holds regardless of
any model, and the page changes nothing. **The fitted forecast, the scenario
table, the guardrail builder and actually creating a rollout are A3** — so this
screen promises none of them and has no button that goes nowhere. It also
surfaces the compare-at policy (R13) ahead of time: when a new price would reach
or pass a crossed-out price, it says that price will be removed rather than show
a fake discount.

**A 500-SKU catalog to test against.** The mock now generates the catalog from a
fixed seed (never `Math.random`, so server render, hydration and build agree):
15 curated products the rollout/journal fixtures reference by id, plus 485
generated ones across 11 product types, ~7% deliberately without a cost. Verified
at 500 rows: no pagination, no virtualization, no page-level horizontal scroll,
typing stays smooth.

### For Lane B

`contracts/requests-lane-a.md` → **REQ-A-004**, three items, all mocked behind a
local seam so landing them is mechanical:

1. **A cost-write server action.** Lane A calls a mocked
   `saveProductCost(productId, cogsCents | null)` that already returns
   `{ok:true, cogsCents} | {ok:false, message}`. Integer cents; `null` must be
   allowed so a mistyped cost can go back to unknown; `message` is shown to the
   merchant verbatim; set `cogs_source='manual'`; **do not reject a cost above the
   price** — loss leaders are real, Lane A warns and saves.
2. **`productType` on `Product`** (Shopify product type) — drives the type filter.
3. **A server-side proposal draft** to replace the `sessionStorage` hand-off:
   `createProposalDraft(productIds) → {id}` / `getProposalDraft(id)`. Worth having
   before A3 builds the real propose flow on top of it.

### Known limitation, stated rather than hidden

The catalog→preview hand-off uses `sessionStorage`
(`components/catalog/selection.ts`), because 400 selected ids in a query string
is a 6 kB URL. Consequences: `/propose` is client-rendered, and a shared or
bookmarked `/propose` URL has no selection — which is why that screen has a
designed empty state pointing back at the catalog rather than an error. REQ-A-004
item 3 is the fix.

### Bugs found and fixed during A2 visual QA

- Sorting by cost or profit put "no cost yet" rows at the **top** in descending
  order, because the null ranking was inside the direction flip. Unknowns are now
  ranked outside it and stay last either way.
- The cost column jumped width when a cost went into edit mode, pushing the
  Status column out of view. Reserved a min-width on that column.
- The cost cell repeated the margin that the profit column already showed.
- Generated products collided on name, producing three visually identical rows
  after sorting — which reads as a rendering bug. The generator now re-draws and
  falls back to a model number.

### Verification

`npx tsc --noEmit` clean, `next build` green (7 routes, 14 static pages) in the
out-of-repo harness. Driven in a browser: search filters, type/cost/price filters,
sort direction toggles, select → sticky bar → preview hand-off, inline cost edit
saved by both Enter and the confirm button (the notice count drops and the row
leaves the "no cost yet" filter), and the increase *and* decrease breakeven
arithmetic checked by hand. Checked at 390px and 1440px, light and dark;
`document.documentElement.scrollWidth === window.innerWidth` at 390px.

---

## Sprint A1 — done

### The two things the other lanes need to know first

1. **There is no root project scaffold on `main`, and Lane A cannot create one.**
   At A1 start the repo contained only `PRD.md`, `BUILD_BRIEF.md`, `README.md`,
   `LICENSE` — no `package.json`, `tsconfig.json`, `next.config.*`,
   `postcss.config.*`. Those are Lane B-owned root configs. **`npm run build`
   therefore cannot run on `main` until Lane B lands them.** The exact four
   files, verbatim and version-pinned to what Lane A verified against, are in
   `contracts/requests-lane-a.md` → **REQ-A-001**. Landing them is a copy-paste;
   please do it in B1 if it isn't already done.

   Lane A did not ship an unverified sprint: `app/**` and `components/**` were
   copied into a throwaway Next 15.5 / React 19.2 / Tailwind 4.3 harness **outside
   the repo** (deliberately outside, so an untracked root `package.json` could
   never collide with Lane B's push) and verified there:
   - `npx tsc --noEmit` → clean
   - `next build` → green, 6 routes, 13 static pages, no type errors
   - every page opened in a browser at 1320px and 390px, light and dark

2. **A1 said "refactor v0's three pages onto the primitives" — there were no v0
   pages.** No `lib/`, no `app/`, no `components/` existed. Lane A therefore
   *authored* the three pages directly on the new primitives, which reaches the
   same end state A1 asks for. Consequence for scope: the pages are at v0 depth
   on purpose — search/filter/multi-select is A2, the propose flow is A3, the
   actual-vs-expected chart and kill switch are A4. See "Deliberately not built".

### What landed

**Design tokens** — `app/globals.css`. Tailwind v4 is CSS-first, so there is
**no `tailwind.config.js` and please don't add one** (it would split token
ownership across lanes). Structure: raw `--pf-*` values declared twice
(light / dark), then `@theme inline` maps them onto utility names.

- Consequence worth knowing: **no component writes a `dark:` variant.** They use
  semantic tokens (`bg-surface`, `text-ink-muted`, `border-border`) and are
  correct in both themes by construction. Dark follows the OS today;
  `[data-theme="light"|"dark"]` on `<html>` is already wired for the explicit
  toggle in A7.
- Status colour meanings are fixed app-wide and used nowhere else: **live** = a
  Priceflag price is on the storefront now · **hold** = waiting on purpose
  (scheduled, holding a step, paused) · **breach** = below the expected range or
  reverted · **accent** = an action or a link. Green never means "healthy"; it
  means "live".
- Type scale is dense-admin: `text-base` is **14px**, `text-md` is 16px and is
  what form controls use below `sm` so iOS Safari doesn't zoom on focus.

**Primitives** — `components/ui/*`, barrelled at `components/ui/index.ts`
(import from the barrel): `Button` / `ButtonLink` / `TextLink`, `Card` +
`CardHeader` / `CardBody` / `CardFooter` / `CardDivider`, `Table` + `THead` /
`TBody` / `TR` / `TH` / `TD` / `CellNote` / `TableEmptyRow`, `Badge` + `Tag`,
`Field` / `Input` / `SearchInput` / `Select` / `Checkbox`, `Modal`, `Toast`
(`ToastProvider` + `useToast`), `Skeleton` / `SkeletonText` / `SkeletonTable` /
`SkeletonCard`, `EmptyState`, plus `Notice`, `PageHeader`, `Stat` / `StatGroup` /
`DetailList` / `DetailRow`, and `components/ui/icons.tsx`.

**Zero runtime dependencies added, and Lane A intends to keep it that way.** No
`clsx`, no `tailwind-merge`, no `cva`, no `lucide-react`, no chart library, no
`next/font` network fetch. Class joining is a 6-line local helper
(`components/cn.ts`), icons are inline SVG, fonts are a system stack. If Lane A
ever needs a dependency it gets requested in `contracts/requests-lane-a.md`
first, never added to `package.json` directly.

**App shell** — `components/shell/*`. Permanent nav rail ≥`lg`, sticky bar +
drawer below it, skip link, one content column (`max-w-6xl`). The nav carries a
server-rendered **"what is live right now"** card on every screen, because that
is the product's core promise and therefore chrome, not content.

**Pages** — `app/page.tsx` (overview), `app/products/page.tsx`,
`app/rollouts/page.tsx`, `app/rollouts/[id]/page.tsx`, `app/journal/page.tsx`,
plus `loading.tsx` (root + rollout detail), `error.tsx`, `not-found.tsx`.

**Domain wording lives in one file** — `components/domain/status.tsx` holds every
merchant-facing sentence for rollout state: status labels, the change sentence,
the breakeven sentence, confidence tiers, the guardrail sentence, reading
verdicts. Single source so the app can't say "guardrail threshold" on one screen
and "abort condition" on another. **Lanes B and C: if you send an `explanation`
or a plain-language event `message`, Lane A renders it verbatim — so it has to be
plain language (R25). No "elasticity", no "confidence interval", no
"threshold breached".**

### The mock, and how to delete it

`components/mock/engine.ts` is the **only** file Lane A must delete when Lane B
lands `lib/`. It holds the engine types Lane A guessed at plus demo-store
fixtures (15 products, 6 rollouts covering all 7 statuses, 12 journal entries).
Pages import from it and only from it, so the swap is mechanical.

The guessed shapes are written up as a table for Lane B in
`contracts/requests-lane-a.md` → **REQ-A-003**, along with two behavioural asks:
a single store-wide "what is live right now" read, and rollback / kill-switch as
awaitable server actions returning `{ok, affectedSkus, message}`. **Lane A will
follow `contracts/` and `lib/types.ts` once they exist — the mock is a
placeholder, not a claim.**

Two notes on the fixtures, in case Lane B seeds from them: money is integer cents
everywhere (`components/format.ts` is the only file that divides by 100), and
`DEMO_TODAY` is pinned to `2026-07-29` so server and client renders always agree.

### Quality bar (PRD §6.5)

- **R25 plain language** — no statistics vocabulary in any merchant-facing
  string. "If daily orders fall more than 30% below what we expect for 2 days in
  a row, every price goes back automatically." The breakeven sentence is stated
  *before* any model output, because it is pure margin arithmetic and always
  true. Confidence tiers read "Based on your own sales" / "Based on limited
  history" / "Based on a general assumption", each with its one-line why.
- **R26 every state designed** — empty, loading, error, not-found, no-cost
  (`Profit unknown`, never a fabricated profit), thin-data (`assumption` tier),
  paused-by-external-edit, rolled-back, draft, scheduled. Every table has an
  empty row; every empty state links somewhere real. There are **no links to
  routes that don't exist yet** — no dead ends, and no UI advertising unbuilt
  features.
- **R27 accessible & responsive** — verified at 390px and 1320px, light and dark;
  keyboard-reachable skip link; modal traps focus, closes on Escape, restores
  focus; toasts are `aria-live="polite"`; the interval mark carries a text
  verdict badge so status colour never carries meaning alone. **The formal WCAG
  AA contrast audit is A7's deliverable and has not been run yet** — tokens were
  chosen to clear 4.5:1 but that is not the same as measured.
- **Glance test** — every screen answers "what is live right now, and how do I
  undo it": the nav's live card, the overview's live card, and the rollout page,
  where the undo *is* the single primary action whenever a Priceflag price is on
  the storefront. The confirm dialog names the product count and promises a
  journal row.

### Bugs found and fixed during A1 visual QA

Recorded because they are the kind of thing that silently returns:

- **Mobile horizontal overflow.** Grid/flex children default to
  `min-width: auto`, so a wide table pushed the whole page sideways instead of
  scrolling inside its own container. Fixed with `min-w-0` on `Card`, `CardBody`,
  the table scroll wrapper, and the page-level grid columns. Verified
  `document.documentElement.scrollWidth === window.innerWidth` at 390px.
- **`Table` forced `min-w-max` on every table**, which clipped a 4-column table
  inside a narrow card. Now a `layout` prop: `fit` (default, cells wrap) vs
  `intrinsic` (no wrap, scrolls sideways) for the wide data tables.
- **A paused rollout wore the calm green of a healthy one**, and showed a green
  "0 of 2". Card tone now derives from status (`rolloutCardTone`), and the tone
  of "products on a new price" follows the actual count.
- Badges wrapped mid-label in the narrow rail; `whitespace-nowrap shrink-0`.

### Deliberately not built in A1 (so nobody duplicates it)

Catalog search / filter / sort / multi-select and inline COGS editing → **A2**.
Propose flow, the full forecast card with the scenario table, the guardrail
builder → **A3**. The actual-vs-expected chart with its uncertainty band, the
store-level kill switch, richer breach states → **A4**; A1 renders the readings
as a shared-scale interval mark in a table instead
(`components/domain/expected-range.tsx`), following the repo dataviz conventions
so A4 can build on it rather than replace it. Connect-store and sync progress →
**A5**. Journal filters and CSV download → **A6**. The measured contrast /
keyboard audit → **A7**.

### For Lane B specifically

1. Land REQ-A-001's four root config files. Nothing else in Lane A is blocked,
   but `npm run build` on `main` is, until then.
2. `tsconfig.json` must keep `"paths": {"@/*": ["./*"]}` — every Lane A import
   uses it. If your scaffold differs (`src/` layout, different alias), land yours
   and note it in `docs/lane-status/lane-b.md`; Lane A will adapt next sprint
   rather than fight the scaffold.
3. Please don't add `tailwind.config.js`, and please don't edit `app/globals.css`
   (Lane A-owned) — tokens live there.
4. Confirm or correct the shapes in REQ-A-003 when `contracts/` lands.

### For Lane C

Lane A renders whatever confidence tier arrives and never blocks on a model:
`fitted` / `partial` / `assumption` each already have a badge, a colour, and a
plain-language fallback sentence. If you send `explanation` per
`forecast_result.schema.json`, Lane A prefers yours over its fallback — so write
it for a merchant, not for a statistician. `model_version` is rendered as a
traceability line under the forecast card (R31).
